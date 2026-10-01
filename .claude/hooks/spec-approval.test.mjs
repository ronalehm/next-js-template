// @vitest-environment node
// Run: npx vitest run .claude/hooks
import { test } from "vitest";
import assert from "node:assert/strict";
import { spawnSync, execSync } from "node:child_process";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(import.meta.dirname, "spec-approval.mjs");

function project() {
  const dir = mkdtempSync(join(tmpdir(), "spec-approval-"));
  mkdirSync(join(dir, "docs/specs"), { recursive: true });
  execSync("git init -q && git config user.name Tester && git config user.email t@x.io", { cwd: dir });
  const env = { ...process.env, CLAUDE_PROJECT_DIR: dir, SPEC_APPROVAL_KEY_FILE: join(dir, "key") };
  const run = (mode, payload) => {
    const r = spawnSync("node", [HOOK, mode], { input: JSON.stringify(payload), env, encoding: "utf8" });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const spec = (name, body = "") =>
    writeFileSync(join(dir, `docs/specs/${name}.md`), `# ${name}\n\n- Estado: borrador\n\n- [ ] T1\n${body}`);
  const file = (name) => readFileSync(join(dir, `docs/specs/${name}.md`), "utf8");
  const write = (name, text) => writeFileSync(join(dir, `docs/specs/${name}.md`), text);
  const say = (prompt) => run("record", { prompt });
  const dev = (prompt) => run("gate", { tool_input: { subagent_type: "developer", prompt } });
  const ledger = join(dir, "docs/specs/approvals.jsonl");
  return { dir, env, ledger, spec, file, write, say, dev };
}

test("only the user's 'apruebo' unlocks developer, and records who approved", () => {
  const p = project();
  p.spec("users-list");
  assert.equal(p.dev("docs/specs/users-list.md").code, 2, "draft blocks");

  p.write("users-list", p.file("users-list").replace("borrador", "aprobado"));
  assert.equal(p.dev("docs/specs/users-list.md").code, 2, "agent-written aprobado without ledger blocks");

  p.spec("users-list");
  const r = p.say("apruebo docs/specs/users-list.md");
  assert.equal(r.code, 0);
  assert.match(r.out, /Tester <t@x.io>/);
  assert.match(r.out, /Continúa ahora con la implementación/);
  assert.match(p.file("users-list"), /Estado: aprobado/);
  const ledger = JSON.parse(readFileSync(join(p.dir, "docs/specs/approvals.jsonl"), "utf8"));
  assert.equal(ledger.approver, "Tester <t@x.io>");
  assert.equal(p.dev("docs/specs/users-list.md").code, 0, "approved passes");
});

test("ticking tasks keeps approval; editing the spec invalidates it", () => {
  const p = project();
  p.spec("a");
  p.say("apruebo docs/specs/a.md");
  p.write("a", p.file("a").replace("- [ ] T1", "- [x] T1"));
  assert.equal(p.dev("docs/specs/a.md").code, 0);
  p.write("a", p.file("a") + "- nuevo requisito\n");
  const r = p.dev("docs/specs/a.md");
  assert.equal(r.code, 2);
  assert.match(r.out, /cambió después de su aprobación/);
});

test("record: only 'apruebo docs/specs/<slug>.md' approves", () => {
  const p = project();
  p.spec("a");
  p.spec("b");
  assert.equal(p.say("no apruebo").code, 0, "normal message passes through");
  assert.equal(p.say("apruebo pero cambia X").code, 0, "normal message passes through");
  for (const attempt of ["apruebo", "apruebo b", "apruebo b.md"]) {
    const r = p.say(attempt);
    assert.equal(r.code, 2, `"${attempt}" is rejected`);
    assert.match(r.out, /apruebo docs\/specs\/<slug>\.md.*Pendientes: docs\/specs\/a\.md, docs\/specs\/b\.md/);
  }
  assert.match(p.file("a") + p.file("b"), /^(?![\s\S]*aprobado)/, "nothing approved yet");
  assert.match(p.say("apruebo docs/specs/nope.md").out, /no existe/);

  assert.equal(p.say("Apruebo docs\\specs\\b.md").code, 0, "windows path ok");
  assert.match(p.file("b"), /Estado: aprobado/);
  assert.match(p.file("a"), /Estado: borrador/);
  assert.match(p.say("apruebo docs/specs/b.md").out, /ya está aprobada/);
});

test("gate: build mode, other agents, missing spec, bad input", () => {
  const p = project();
  assert.equal(p.dev("Modo: build. Cambia un color").code, 0);
  assert.equal(p.dev("haz la feature").code, 2);
  assert.equal(p.dev("docs\\specs\\nope.md").code, 2);
  const other = spawnSync("node", [HOOK, "gate"], {
    input: JSON.stringify({ tool_input: { subagent_type: "reviewer", prompt: "x" } }),
    env: p.env,
  });
  assert.equal(other.status, 0);
  assert.equal(spawnSync("node", [HOOK, "gate"], { input: "not json", env: p.env }).status, 2, "fails closed");
});

test("signature: forged or foreign ledger lines are ignored", () => {
  const p = project();
  p.spec("a");
  p.say("apruebo docs/specs/a.md");
  assert.match(readFileSync(p.ledger, "utf8"), /"sig":"[0-9a-f]{64}"/);

  const original = p.file("a");
  const line = (obj) => `${JSON.stringify(obj)}\n`;

  // An agent edits the approved spec and appends a ledger line with a new hash, reusing the old sig.
  p.write("a", original + "- requisito colado\n");
  const entry = JSON.parse(readFileSync(p.ledger, "utf8"));
  appendFileSync(p.ledger, line({ ...entry, hash: "0".repeat(64) }));
  assert.match(p.dev("docs/specs/a.md").out, /cambió después de su aprobación/);

  // A hand-written line for a never-approved spec, without a valid signature.
  p.spec("b");
  p.write("b", p.file("b").replace("borrador", "aprobado"));
  appendFileSync(p.ledger, line({ spec: "docs/specs/b.md", hash: "x", approver: "Tester", date: "d", sig: "f".repeat(64) }));
  assert.match(p.dev("docs/specs/b.md").out, /firma válida/);

  // Ledger signed with another machine's key.
  p.write("a", original);
  assert.equal(p.dev("docs/specs/a.md").code, 0, "restored spec passes with this machine's key");
  writeFileSync(join(p.dir, "key"), "otra-clave");
  assert.match(p.dev("docs/specs/a.md").out, /firma válida/);
});

test("guard: Claude can only write specs as borrador", () => {
  const p = project();
  const guard = (tool_input) =>
    spawnSync("node", [HOOK, "guard"], { input: JSON.stringify({ tool_input }), env: p.env }).status;
  const path = join(p.dir, "docs/specs/a.md");

  assert.equal(guard({ file_path: path, content: "# A\n\n- Estado: borrador\n" }), 0, "new draft ok");
  assert.equal(guard({ file_path: path, content: "# A\n\n- Estado: aprobado\n" }), 2, "new approved blocked");
  assert.equal(guard({ file_path: path, content: "# A\n" }), 2, "spec without Estado blocked");
  assert.equal(guard({ file_path: path, old_string: "Estado: borrador", new_string: "Estado: aprobado" }), 2);
  assert.equal(guard({ file_path: path, old_string: "- Estado: borrador", new_string: "" }), 2, "removing Estado blocked");
  assert.equal(guard({ file_path: path, old_string: "Estado: aprobado", new_string: "Estado: borrador" }), 0, "back to draft ok");
  assert.equal(guard({ file_path: path, old_string: "- [ ] T1", new_string: "- [x] T1" }), 0, "ticking ok");
  assert.equal(guard({ file_path: path, edits: [{ old_string: "x", new_string: "Estado: aprobado" }] }), 2, "MultiEdit");
  assert.equal(guard({ file_path: join(p.dir, "README.md"), content: "Estado: aprobado" }), 0, "other files ignored");
  assert.equal(guard({ file_path: String.raw`C:\repo\docs\specs\a.md`, content: "Estado: aprobado" }), 2, "windows path");
});

test("developer: specs are read-only for the developer agent", () => {
  const p = project();
  const dev = (tool_name, tool_input) =>
    spawnSync("node", [HOOK, "developer"], { input: JSON.stringify({ tool_name, tool_input }), env: p.env }).status;
  const spec = join(p.dir, "docs/specs/a.md");

  assert.equal(dev("Edit", { file_path: spec, old_string: "- [ ] T1", new_string: "- [x] T1" }), 2);
  assert.equal(dev("Write", { file_path: join(p.dir, "docs/specs/approvals.jsonl"), content: "{}" }), 2);
  assert.equal(dev("Write", { file_path: String.raw`C:\repo\docs\specs\a.md`, content: "x" }), 2);
  assert.equal(dev("Bash", { command: "sed -i 's/borrador/aprobado/' docs/specs/a.md" }), 2);
  assert.equal(dev("Bash", { command: 'echo x > "./docs/specs/a.md"' }), 2);
  assert.equal(dev("Write", { file_path: join(p.dir, "modules/users/index.ts"), content: "x" }), 0);
  assert.equal(dev("Write", { file_path: join(p.dir, "docs/SETUP.md"), content: "x" }), 0);
  assert.equal(dev("Bash", { command: "npx vitest run modules/users" }), 0);
});
