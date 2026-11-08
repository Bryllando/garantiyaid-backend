import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("an occupied API port exits cleanly without starting workers or disturbing its owner", async (t) => {
  const owner = createServer((_request, response) => response.end("existing server"));
  await new Promise((resolve) => owner.listen(0, resolve));
  t.after(() => new Promise((resolve) => owner.close(resolve)));
  const port = owner.address().port;

  const result = await new Promise((resolve) => {
    execFile(process.execPath, ["src/server.js"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      timeout: 45_000,
      windowsHide: true,
      env: {
        ...process.env,
        DOTENV_CONFIG_PATH: "test/nonexistent.env",
        NODE_ENV: "development",
        PORT: String(port),
        DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
        REDIS_URL: "redis://127.0.0.1:1",
        EMAIL_PROVIDER_MODE: "DISABLED",
      },
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });

  assert.equal(result.error?.code, 1, result.stderr);
  assert.match(result.stderr, new RegExp(`port ${port} is already in use`));
  assert.match(result.stderr, /Keep only one backend terminal running/);
  assert.doesNotMatch(result.stdout + result.stderr, /Unhandled|WORKER_UNAVAILABLE|CLEANUP_FAILED|RELAY|API listening/);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), "existing server");
});
