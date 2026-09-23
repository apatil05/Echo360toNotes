# AWS pipeline

Handles lectures that need transcription: recordings uploaded from the web app and audio captured by the extension.

```
browser ──POST {jobId}──▶ upload-url Lambda ──▶ presigned S3 form (15 min, exact size + type)
browser ──upload──▶ S3 uploads/<user>/<job> ──event──▶ SQS ──▶ worker Lambda
worker ──▶ ffmpeg → Whisper → notes ──▶ Supabase (job progress, transcript, notes)
       └─▶ SQS (continues itself when rate-limit pauses don't fit in 15 minutes)
```

- **Students' own keys only.** The worker decrypts the student's key from Supabase Vault for the length of a job. Nothing here pays for a model.
- **Free-tier sized:** arm64 Lambdas, SQS, S3 objects deleted after processing (and after 1 day at most), 2-week log retention, and a $5 monthly budget alert.
- **Safe to retry:** each job is leased before work starts, progress is saved after every notes chunk, and a duplicate delivery does nothing. Messages that fail 3 times go to a dead-letter queue, which sends an alert email.

## Layout

| Path | What |
|---|---|
| `lib/pipeline-stack.js` | CDK stack: bucket, queues, functions, alarms, budget |
| `lambda/worker.js` | SQS handler → `lib/processJob.js` (the job state machine) |
| `lambda/upload-url.js` | Function URL handler → `lib/uploads.js` (auth + validation) |
| `lambda/lib/services.js` | Supabase, S3, SQS, SSM, and ffmpeg adapters |
| `test/` | Unit tests, CloudFormation assertions, and a local-Supabase integration test |

The worker reuses `../src` (provider presets, notes generator, Whisper client), so the hosted pipeline and the local server produce the same notes.

## Tests

Requires Node 22+ (`nvm use 22`).

```bash
npm install
npm test
```

The integration test needs local Supabase running (`supabase start` from the repo root):

```bash
npm run test:integration
```

## Deploying

You need an AWS account, the AWS CLI signed in (`aws configure sso` or `aws configure`), and a Supabase project with the migrations applied (`supabase link`, then `supabase db push`).

1. Store the Supabase **secret key** (Project Settings → API Keys) in SSM Parameter Store. Standard SecureString parameters are free.

   ```bash
   aws ssm put-parameter --name /echo-notes/supabase-secret-key --type SecureString --value "sb_secret_..."
   ```

2. Download ffmpeg for the Lambda layer (checksum-verified):

   ```bash
   npm run fetch-ffmpeg
   ```

3. Bootstrap CDK once per account and region:

   ```bash
   npx cdk bootstrap
   ```

4. Deploy, passing your settings:

   ```bash
   npx cdk deploy \
     -c supabaseUrl=https://YOUR-REF.supabase.co \
     -c allowedOrigins=https://YOUR-APP-DOMAIN,chrome-extension://YOUR-EXTENSION-ID \
     -c alertEmail=you@example.com
   ```

   The outputs include `UploadUrlEndpoint`, which the web app and extension call. Confirm the SNS subscription email so alerts reach you.

To remove everything, run `npx cdk destroy`. The upload bucket is emptied automatically.
