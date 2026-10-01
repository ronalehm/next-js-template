// Spec approval hooks (see docs/SETUP.md §3).
//   record (UserPromptSubmit): a user message "apruebo docs/specs/<slug>.md" approves that spec:
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
  const prompt = (input.prompt ?? "").trim();
  const match = prompt.match(/^apruebo\s+(?:\.[\\/])?docs[\\/]specs[\\/]([\w-]+)\.md$/i);

  if (!match) {
    // "apruebo" or "apruebo <algo>" looks like an approval attempt: reject it so the user isn't misled.
    if (!/^apruebo(\s+\S+)?$/i.test(prompt)) return;
    const dir = resolve(root, SPECS);
    const pending = (existsSync(dir) ? readdirSync(dir) : [])
      .filter((f) => f.endsWith(".md"))
      .map((f) => `${SPECS}/${f}`)
      .filter((s) => !isValid(s, read(s)));
    block(
      `para aprobar escribe exactamente "apruebo docs/specs/<slug>.md".` +
        (pending.length ? ` Pendientes: ${pending.join(", ")}.` : " No hay specs pendientes."),
    );
  }

  const spec = `${SPECS}/${match[1]}.md`;
  if (!existsSync(resolve(root, spec))) block(`la spec ${spec} no existe.`);
  const text = read(spec);
  if (isValid(spec, text)) block(`la spec ${spec} ya está aprobada y sin cambios.`);
  if (!STATE_LINE.test(text)) block(`la spec ${spec} no tiene línea "Estado:".`);
  const approved = text.replace(STATE_LINE, "$1aprobado");
  const entry = { spec, hash: hash(approved), approver: approver(), date: new Date().toISOString() };
  entry.sig = sign(key({ create: true }), entry);
  writeFileSync(resolve(root, spec), approved);
  appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`);
  // UserPromptSubmit stdout is added to Claude's context: it confirms the approval and starts implementation.
  console.log(
    `Spec ${spec} aprobada por ${entry.approver} (${entry.date}); el hook cambió su cabecera a "Estado: aprobado". ` +
      `Continúa ahora con la implementación siguiendo el flujo del orquestador (.claude/agents/orchestrator.md, sección 3 desde el paso 4): ` +
      `lanza el agente developer con la ruta ${spec} según el plan de tareas y después el reviewer. No vuelvas a pedir aprobación.`,
  );
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
      block(`la spec ${spec} cambió después de su aprobación (${last.approver}, ${last.date}). El usuario debe volver a escribir "apruebo ${spec}".`);
    }
    if (!last && entries(spec).length > 0) {
      block(`la spec ${spec} no tiene una aprobación con firma válida en este equipo (registro alterado o aprobada en otra máquina). El usuario debe volver a escribir "apruebo ${spec}".`);
    }
    block(`la spec ${spec} no está aprobada. El usuario debe escribir "apruebo docs/specs/<slug>.md" en el chat.`);
  }
}

// guard (PreToolUse Write|Edit): Claude may only write specs as `Estado: borrador`.
// Only the record hook (user's "apruebo") sets `aprobado`.
// ponytail: Bash redirects (echo > spec.md) bypass this; the gate still rejects unsigned approvals.
function guard() {
  const { file_path = "", content, new_string, old_string = "", edits } = input.tool_input ?? {};
  if (!/(^|[\\/])docs[\\/]specs[\\/][^\\/]+\.md$/i.test(file_path)) return;

  const states = (text = "") => [...text.matchAll(/^\s*-?\s*Estado:[ \t]*(.*)$/gim)].map((m) => m[1].trim());
  const onlyDraft = (text) => states(text).every((s) => /^borrador\b/i.test(s));
  const reason = `las specs solo se escriben con "Estado: borrador"; la aprobación la hace el usuario escribiendo "apruebo docs/specs/<slug>.md" (${file_path}).`;

  if (content !== undefined) {
    if (states(content).length === 0 || !onlyDraft(content)) block(reason);
    return;
  }
  for (const e of edits ?? [{ old_string, new_string }]) {
    if (!onlyDraft(e.new_string)) block(reason);
    if (states(e.old_string ?? "").length > 0 && states(e.new_string).length === 0) block(reason);
  }
}

// developer (PreToolUse inside the developer agent): specs are read-only for developer.
// Read/Glob/Grep are allowed; writing tools and any Bash command that names docs/specs are blocked.
function developer() {
  const { file_path = "", notebook_path = "", command = "" } = input.tool_input ?? {};
  const SPEC_PATH = /(^|[\\/\s"'])docs[\\/]specs([\\/]|\b)/i;
  const tool = input.tool_name ?? "";
  if (tool === "Bash" ? SPEC_PATH.test(command) : SPEC_PATH.test(file_path || notebook_path)) {
    block("el agente developer nunca modifica docs/specs/ (solo puede leer las specs con Read).");
  }
}

const mode = { record, gate, guard, developer }[process.argv[2]];
if (!mode) block(`modo desconocido "${process.argv[2]}".`);
mode();
