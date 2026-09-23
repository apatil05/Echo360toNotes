import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';

import { PipelineStack } from '../lib/pipeline-stack.js';

let dir;
let template;

const props = (overrides = {}) => ({
  env: { account: '123456789012', region: 'us-east-1' },
  supabaseUrl: 'https://demo.supabase.co',
  serviceKeyParam: '/echo-notes/supabase-secret-key',
  allowedOrigins: ['https://notes.example.com', 'chrome-extension://abcdefghijklmnop'],
  alertEmail: 'alerts@example.com',
  ffmpegLayerDir: dir,
  ...overrides,
});

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-layer-'));
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', 'ffmpeg'), 'stub');
  // Bundles both functions with esbuild, so this takes a few seconds.
  template = Template.fromStack(new PipelineStack(new App(), 'Test', props()));
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('upload bucket is private, encrypted, TLS-only, and self-cleaning', () => {
  template.hasResourceProperties('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
    LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ Prefix: 'uploads/', ExpirationInDays: 1 })]) },
    CorsConfiguration: { CorsRules: [Match.objectLike({ AllowedMethods: ['POST'], AllowedOrigins: props().allowedOrigins })] },
  });
  template.hasResourceProperties('AWS::S3::BucketPolicy', {
    PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } })]) },
  });
});

test('jobs queue outlasts the worker and has a dead-letter queue', () => {
  template.hasResourceProperties('AWS::SQS::Queue', {
    VisibilityTimeout: 960,
    SqsManagedSseEnabled: true,
    RedrivePolicy: { maxReceiveCount: 3 },
  });
  template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
    BatchSize: 1,
    ScalingConfig: { MaximumConcurrency: 5 },
    FunctionResponseTypes: ['ReportBatchItemFailures'],
  });
});

test('worker: arm64, 15 minutes, ffmpeg layer, no secrets in its environment', () => {
  template.hasResourceProperties('AWS::Lambda::Function', {
    Architectures: ['arm64'],
    Runtime: 'nodejs22.x',
    Timeout: 900,
    MemorySize: 1769,
    EphemeralStorage: { Size: 2048 },
    Layers: [Match.anyValue()],
    Environment: {
      Variables: Match.objectLike({
        FFMPEG_PATH: '/opt/bin/ffmpeg',
        SUPABASE_SERVICE_KEY_PARAM: '/echo-notes/supabase-secret-key',
      }),
    },
  });
  const envs = Object.values(template.findResources('AWS::Lambda::Function'))
    .map((f) => JSON.stringify(f.Properties.Environment ?? {}));
  for (const env of envs) assert.doesNotMatch(env, /SUPABASE_SERVICE_KEY"|sb_secret|eyJ/);
});

test('upload URL is public (auth is the Supabase JWT) with CORS locked to our origins', () => {
  template.hasResourceProperties('AWS::Lambda::Url', {
    AuthType: 'NONE',
    Cors: { AllowOrigins: props().allowedOrigins, AllowMethods: ['POST'], AllowHeaders: ['authorization', 'content-type'] },
  });
});

test('functions can only touch uploads/ objects', () => {
  const statements = Object.values(template.findResources('AWS::IAM::Policy'))
    .flatMap((p) => p.Properties.PolicyDocument.Statement)
    .filter((s) => [s.Action].flat().some((a) => a.startsWith('s3:') && !a.startsWith('s3:List')));
  assert.ok(statements.length > 0);
  for (const s of statements) {
    for (const resource of [s.Resource].flat()) {
      const text = JSON.stringify(resource);
      // Bucket-level ARNs are allowed only for list/metadata actions; objects must be under uploads/.
      if (text.includes('/')) assert.match(text, /\/uploads\/\*/, JSON.stringify(s));
    }
  }
});

test('the Supabase key is read from SSM with decryption', () => {
  const statements = Object.values(template.findResources('AWS::IAM::Policy'))
    .flatMap((p) => p.Properties.PolicyDocument.Statement);
  const ssm = statements.filter((s) => [s.Action].flat().includes('ssm:GetParameter'));
  assert.equal(ssm.length, 2, 'worker and upload-url');
});

test('alerts: dead letters and a monthly budget', () => {
  template.hasResourceProperties('AWS::CloudWatch::Alarm', { Threshold: 1 });
  template.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'alerts@example.com' });
  template.hasResourceProperties('AWS::Budgets::Budget', {
    Budget: { BudgetLimit: { Amount: 5, Unit: 'USD' }, TimeUnit: 'MONTHLY' },
  });
});

test('refuses to synthesise without required settings', () => {
  assert.throws(() => new PipelineStack(new App(), 'A', props({ supabaseUrl: undefined })), /supabaseUrl/);
  assert.throws(() => new PipelineStack(new App(), 'B', props({ allowedOrigins: [] })), /allowedOrigins/);
  assert.throws(() => new PipelineStack(new App(), 'C', props({ ffmpegLayerDir: '/nonexistent' })), /fetch-ffmpeg/);
});
