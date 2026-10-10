#!/usr/bin/env node
// A closed pipe (`llm-usage-analyzer | head -3`) must not stop the program. Writing to it fails with EPIPE, and that is fine.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') throw err;
  });
}

if (process.argv.length === 3 && process.argv[2] === 'statusline') {
  // Claude Code runs this on every update, so it takes a path of its own that starts quickly
  const { runStatusline } = await import('./commands/statusline-run.js');
  await runStatusline();
} else {
  await import('./cli.js');
}

// Makes this file a module, so the top-level await above is allowed
export {};
