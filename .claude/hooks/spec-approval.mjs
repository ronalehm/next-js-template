// Spec approval hooks (see docs/SETUP.md §3).
//   record (UserPromptSubmit): a user message "apruebo [spec-name]" approves a pending spec:
//     sets `Estado: aprobado` and appends { spec, hash, approver, date, sig } to docs/specs/approvals.jsonl.
//     Only real user prompts trigger this hook, so agents cannot approve.
//     `sig` is an HMAC with a per-machine key kept outside the repo (~/.claude/spec-approval.key), so
//     hand-written ledger lines are ignored. Ceiling: any process running as this OS user can read the key;
//     settings.json denies Claude's file tools on it, but a deliberate Bash command still could.
//   gate (PreToolUse Agent): launching `developer` requires every cited spec to be approved AND
//     unchanged since its last approval, or the prompt to declare `Modo: build`.
// Exit 2 = block, stderr is the reason. Fails closed.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { execSync } from "node:child_process";
import { homedir, userInfo } from "node:os";

process.on("uncaughtException", (err) => block(`error en el hook de aprobación (${err.message}).`));

function block(reason) {
  console.error(`BLOQUEADO: ${reason}`);
  process.exit(2);
}

const SPECS = "docs/specs";
const input = JSON.parse(readFileSync(0, "utf8"));
const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const ledgerPath = resolve(root, SPECS, "approvals.jsonl");

const read = (spec) => readFileSync(resolve(root, spec), "utf8").replace(/\r\n/g, "\n");
const STATE_LINE = /^(\s*-?\s*Estado:[ \t]*).*$/im;
const isApproved = (text) => /^\s*-?\s*Estado:\s*aprobado\b/im.test(text);
// The Estado line and checkbox ticks change during the flow; any other change invalidates the approval.
const hash = (text) =>
  createHash("sha256").update(text.replace(STATE_LINE, "").replace(/- \[x\]/gi, "- [ ]")).digest("hex");

const keyPath = process.env.SPEC_APPROVAL_KEY_FILE || join(homedir(), ".claude", "spec-approval.key");

function key({ create = false } = {}) {
  if (!existsSync(keyPath)) {
    if (!create) return null;
    mkdirSync(dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  return readFileSync(keyPath, "utf8").trim();
}

const sign = (k, { spec, hash, approver, date }) =>
  createHmac("sha256", k).update([spec, hash, approver, date].join("\n")).digest("hex");

function signed(k, entry) {
  if (!k || typeof entry.sig !== "string") return false;
  const expected = Buffer.from(sign(k, entry));
  const actual = Buffer.from(entry.sig);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const entries = (spec) =>
  (existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [])
    .filter((entry) => entry.spec === spec);

// Unsigned or forged lines are ignored.
const lastApproval = (spec) => {
  const k = key();
  return entries(spec).filter((entry) => signed(k, entry)).at(-1);
};

const isValid = (spec, text) => isApproved(text) && lastApproval(spec)?.hash === hash(text);

function approver() {
  const git = (key) => {
    try {
      return execSync(`git config ${key}`, { cwd: root, encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  };
  const name = git("user.name");
  return name ? `${name} <${git("user.email")}>` : userInfo().username;
}

function record() {
  const match = (input.prompt ?? "").trim().match(/^apruebo(?:\s+([\w-]+?)(?:\.md)?)?$/i);
  if (!match) return;

  const dir = resolve(root, SPECS);
  const specs = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => `${SPECS}/${f}`)
    : [];
  const pending = specs.filter((spec) => !isValid(spec, read(spec)));

  let spec;
  if (match[1]) {
    spec = `${SPECS}/${match[1]}.md`;
    if (!specs.includes(spec)) block(`la spec ${spec} no existe.`);
    if (!pending.includes(spec)) block(`la spec ${spec} ya está aprobada y sin cambios.`);
  } else if (pending.length === 1) {
    spec = pending[0];
  } else if (pending.length === 0) {
    block("no hay specs pendientes de aprobación.");
  } else {
    const names = pending.map((s) => s.slice(SPECS.length + 1, -3)).join(", ");
    block(`hay varias specs pendientes (${names}). Escribe "apruebo <nombre>".`);
  }

  const text = read(spec);
  if (!STATE_LINE.test(text)) block(`la spec ${spec} no tiene línea "Estado:".`);
  const approved = text.replace(STATE_LINE, "$1aprobado");
  const entry = { spec, hash: hash(approved), approver: approver(), date: new Date().toISOString() };
  entry.sig = sign(key({ create: true }), entry);
  writeFileSync(resolve(root, spec), approved);
  appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`);
  console.log(`Spec ${spec} aprobada por ${entry.approver} (${entry.date}). Estado: aprobado. Ya se puede implementar.`);
}

function gate() {
  const { subagent_type, prompt = "" } = input.tool_input ?? {};
  if (subagent_type !== "developer") return;

  const specs = [...new Set((prompt.match(/docs[\\/]specs[\\/][\w.-]+\.md/g) ?? []).map((s) => s.replace(/\\/g, "/")))];
  if (specs.length === 0) {
    if (/Modo:\s*build\b/i.test(prompt)) return;
    block("el prompt de developer debe indicar la ruta de la spec (docs/specs/<module>-<feature>.md) o declarar `Modo: build`.");
  }

  for (const spec of specs) {
    if (!existsSync(resolve(root, spec))) block(`la spec ${spec} no existe.`);
    const text = read(spec);
    if (isValid(spec, text)) continue;
    const last = lastApproval(spec);
    if (last && isApproved(text)) {
      block(`la spec ${spec} cambió después de su aprobación (${last.approver}, ${last.date}). El usuario debe volver a escribir "apruebo".`);
    }
    if (!last && entries(spec).length > 0) {
      block(`la spec ${spec} no tiene una aprobación con firma válida en este equipo (registro alterado o aprobada en otra máquina). El usuario debe volver a escribir "apruebo".`);
    }
    block(`la spec ${spec} no está aprobada. El usuario debe escribir "apruebo" en el chat.`);
  }
}

const mode = { record, gate }[process.argv[2]];
if (!mode) block(`modo desconocido "${process.argv[2]}".`);
mode();
