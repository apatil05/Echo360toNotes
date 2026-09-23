// Upload + transcription pipeline:
//
//   browser ──POST──> upload-url Lambda (function URL) ──> presigned S3 POST
//   browser ──upload──> S3 uploads/<user>/<job> ──event──> SQS ──> worker Lambda
//   worker ──> Supabase (job progress, transcript, notes) and SQS (continuations)
//
// Everything here fits the AWS free tier for a student-scale app; a budget
// alarm emails if that ever stops being true.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Stack, Duration, RemovalPolicy, Size, CfnOutput,
  aws_s3 as s3,
  aws_s3_notifications as s3n,
  aws_sqs as sqs,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  aws_lambda_event_sources as sources,
  aws_logs as logs,
  aws_ssm as ssm,
  aws_sns as sns,
  aws_sns_subscriptions as subs,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cwActions,
  aws_budgets as budgets,
} from 'aws-cdk-lib';

const here = path.dirname(fileURLToPath(import.meta.url));
const lambdaDir = path.join(here, '..', 'lambda');
const infraRoot = path.join(here, '..');

const WORKER_TIMEOUT = Duration.minutes(15);

/**
 * props:
 *   supabaseUrl         https://<ref>.supabase.co
 *   serviceKeyParam     SSM SecureString name holding the Supabase secret key
 *   allowedOrigins      web app origin(s) and chrome-extension://<id>
 *   alertEmail          budget and dead-letter alerts
 *   monthlyBudgetUsd    default 5
 *   ffmpegLayerDir      folder containing bin/ffmpeg (see scripts/fetch-ffmpeg.sh)
 */
export class PipelineStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const { supabaseUrl, serviceKeyParam, allowedOrigins, alertEmail, monthlyBudgetUsd = 5, ffmpegLayerDir } = props;

    if (!/^https?:\/\//.test(supabaseUrl ?? '')) throw new Error('supabaseUrl must be the project URL');
    if (!allowedOrigins?.length) throw new Error('allowedOrigins must list the web app (and extension) origins');
    if (!fs.existsSync(path.join(ffmpegLayerDir ?? '', 'bin', 'ffmpeg'))) {
      throw new Error(`No ffmpeg binary in ${ffmpegLayerDir}/bin. Run: npm run fetch-ffmpeg`);
    }

    // ── Storage ──────────────────────────────────────────────────────────────
    const uploads = new s3.Bucket(this, 'Uploads', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      // Lecture audio is processed and deleted; anything left over goes after a day.
      lifecycleRules: [
        { prefix: 'uploads/', expiration: Duration.days(1) },
        { abortIncompleteMultipartUploadAfter: Duration.days(1) },
      ],
      cors: [{
        allowedMethods: [s3.HttpMethods.POST],
        allowedOrigins,
        allowedHeaders: ['*'],
        maxAge: 3000,
      }],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ── Queue ────────────────────────────────────────────────────────────────
    const deadLetters = new sqs.Queue(this, 'JobsDeadLetter', {
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });
    const jobs = new sqs.Queue(this, 'Jobs', {
      // Must outlast the worker, or a running job's message is handed out again.
      visibilityTimeout: WORKER_TIMEOUT.plus(Duration.minutes(1)),
      retentionPeriod: Duration.days(4),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      deadLetterQueue: { queue: deadLetters, maxReceiveCount: 3 },
    });
    uploads.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.SqsDestination(jobs), { prefix: 'uploads/' });

    // ── Functions ────────────────────────────────────────────────────────────
    const serviceKey = ssm.StringParameter.fromSecureStringParameterAttributes(this, 'SupabaseServiceKey', {
      parameterName: serviceKeyParam,
    });

    const bundling = {
      format: nodejs.OutputFormat.ESM,
      target: 'node22',
      minify: true,
      sourceMap: true,
      // Some dependencies still call require(); give ESM bundles a working one.
      banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      // The Node.js runtime ships the AWS SDK v3.
      externalModules: ['@aws-sdk/*'],
    };
    const common = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      // esbuild runs from infra/ and follows imports into ../src (shared with the local server).
      projectRoot: infraRoot,
      depsLockFilePath: path.join(infraRoot, 'package-lock.json'),
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        SUPABASE_URL: supabaseUrl,
        SUPABASE_SERVICE_KEY_PARAM: serviceKeyParam,
        UPLOAD_BUCKET: uploads.bucketName,
      },
    };

    const ffmpeg = new lambda.LayerVersion(this, 'Ffmpeg', {
      code: lambda.Code.fromAsset(ffmpegLayerDir),
      compatibleArchitectures: [lambda.Architecture.ARM_64],
      description: 'Static ffmpeg (arm64)',
    });

    const worker = new nodejs.NodejsFunction(this, 'Worker', {
      ...common,
      entry: path.join(lambdaDir, 'worker.js'),
      memorySize: 1769, // one full vCPU for ffmpeg
      timeout: WORKER_TIMEOUT,
      ephemeralStorageSize: Size.gibibytes(2),
      layers: [ffmpeg],
      environment: {
        ...common.environment,
        QUEUE_URL: jobs.queueUrl,
        FFMPEG_PATH: '/opt/bin/ffmpeg',
      },
      bundling: {
        ...bundling,
        // pdf-parse loads its PDF engine dynamically, so ship it unbundled.
        nodeModules: ['pdf-parse'],
      },
      logGroup: new logs.LogGroup(this, 'WorkerLogs', { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY }),
    });
    worker.addEventSource(new sources.SqsEventSource(jobs, {
      batchSize: 1,
      // Caps parallel jobs (cost, and the students' provider rate limits).
      maxConcurrency: 5,
      reportBatchItemFailures: true,
    }));
    uploads.grantRead(worker, 'uploads/*');
    uploads.grantDelete(worker, 'uploads/*');
    jobs.grantSendMessages(worker);
    serviceKey.grantRead(worker);

    const uploadUrl = new nodejs.NodejsFunction(this, 'UploadUrl', {
      ...common,
      entry: path.join(lambdaDir, 'upload-url.js'),
      memorySize: 256,
      timeout: Duration.seconds(10),
      bundling,
      logGroup: new logs.LogGroup(this, 'UploadUrlLogs', { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY }),
    });
    // Presigned POSTs are signed with this role, so it needs PutObject.
    uploads.grantPut(uploadUrl, 'uploads/*');
    serviceKey.grantRead(uploadUrl);

    // Auth happens in code (Supabase JWT), so the URL itself is public.
    const uploadEndpoint = uploadUrl.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins,
        allowedMethods: [lambda.HttpMethod.POST],
        allowedHeaders: ['authorization', 'content-type'],
        maxAge: Duration.hours(1),
      },
    });

    // ── Alerts ───────────────────────────────────────────────────────────────
    const alerts = new sns.Topic(this, 'Alerts');
    if (alertEmail) alerts.addSubscription(new subs.EmailSubscription(alertEmail));

    new cloudwatch.Alarm(this, 'DeadLettersAlarm', {
      alarmDescription: 'A job message failed 3 times and was moved to the dead-letter queue.',
      metric: deadLetters.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cwActions.SnsAction(alerts));

    if (alertEmail) {
      new budgets.CfnBudget(this, 'MonthlyBudget', {
        budget: {
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: { amount: monthlyBudgetUsd, unit: 'USD' },
        },
        notificationsWithSubscribers: [
          // Any real spend at all ($1 of a $5 budget) is worth knowing about.
          { threshold: 20, type: 'ACTUAL', thresholdType: 'PERCENTAGE' },
          { threshold: 100, type: 'FORECASTED', thresholdType: 'PERCENTAGE' },
        ].map((n) => ({
          notification: { notificationType: n.type, comparisonOperator: 'GREATER_THAN', threshold: n.threshold, thresholdType: n.thresholdType },
          subscribers: [{ subscriptionType: 'EMAIL', address: alertEmail }],
        })),
      });
    }

    new CfnOutput(this, 'UploadUrlEndpoint', { value: uploadEndpoint.url });
    new CfnOutput(this, 'UploadBucketName', { value: uploads.bucketName });
    new CfnOutput(this, 'JobsQueueUrl', { value: jobs.queueUrl });
  }
}
