#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { PipelineStack } from '../lib/pipeline-stack.js';

const app = new App();
const ctx = (key) => app.node.tryGetContext(key);
const list = (value) => (Array.isArray(value) ? value : String(value ?? '').split(',')).map((s) => s.trim()).filter(Boolean);

new PipelineStack(app, 'EchoNotesPipeline', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  supabaseUrl: ctx('supabaseUrl'),
  serviceKeyParam: ctx('serviceKeyParam') ?? '/echo-notes/supabase-secret-key',
  allowedOrigins: list(ctx('allowedOrigins')),
  alertEmail: ctx('alertEmail'),
  monthlyBudgetUsd: Number(ctx('monthlyBudgetUsd') ?? 5),
  ffmpegLayerDir: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'layers', 'ffmpeg'),
  tags: { project: 'echo-notes' },
});
