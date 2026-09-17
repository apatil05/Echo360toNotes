#!/usr/bin/env node

import 'dotenv/config';
import { program } from 'commander';
import chalk from 'chalk';

import { LLM_PROVIDERS, resolveLLMConfig, createClient } from './providers.js';

program
  .name('models')
  .description('List the models available from your notes provider, so you can pick an LLM_MODEL')
  .option('-p, --provider <name>', `Provider to query: ${Object.keys(LLM_PROVIDERS).join(', ')} (overrides LLM_PROVIDER)`)
  .option('--base-url <url>',      'OpenAI-compatible base URL (overrides LLM_BASE_URL)')
  .option('--api-key <key>',       'API key (overrides LLM_API_KEY / provider key)')
  .option('-f, --filter <text>',   'Only show model IDs containing this text')
  .parse();

const opts = program.opts();

async function main() {
  const llm = resolveLLMConfig({ overrides: { provider: opts.provider, baseURL: opts.baseUrl, apiKey: opts.apiKey } });
  // Listing doesn't need a model, so don't let "no default model" block it.
  const client = createClient({ ...llm, model: llm.model ?? '(listing)' }, { timeoutMs: 30_000 });

  const ids = [];
  for await (const m of client.models.list()) ids.push(m.id);
  ids.sort((a, b) => a.localeCompare(b));

  const filter = opts.filter?.toLowerCase();
  const shown = filter ? ids.filter((id) => id.toLowerCase().includes(filter)) : ids;

  console.log(chalk.bold(`\n${llm.label} — ${llm.baseURL}`));
  for (const id of shown) {
    console.log(id === llm.model ? chalk.green(`  ✓ ${id}  (current LLM_MODEL)`) : `    ${id}`);
  }
  console.log(chalk.gray(`\n${shown.length} of ${ids.length} models shown.`));

  if (llm.model && !ids.includes(llm.model)) {
    console.log(chalk.yellow(`⚠️  Configured model "${llm.model}" is not in this list — set LLM_MODEL to one of the IDs above.`));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(chalk.red('❌ Error:'), err.message);
  process.exit(1);
});
