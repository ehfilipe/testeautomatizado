/**
 * AI PR Review Bot (simple)
 * - Builds a diff using git
 * - Sends to OpenAI
 * - Comments back on PR using GitHub API
 *
 * Required env:
 * - OPENAI_API_KEY
 * - GITHUB_TOKEN
 * GitHub provides:
 * - GITHUB_REPOSITORY (owner/repo)
 * - GITHUB_EVENT_PATH (json with pull_request info)
 */

const fs = require("fs");
const { execSync } = require("child_process");

async function main() {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY; // "owner/repo"
  const eventPath = process.env.GITHUB_EVENT_PATH;

  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY secret");
  if (!GITHUB_TOKEN) throw new Error("Missing GITHUB_TOKEN");
  if (!repo) throw new Error("Missing GITHUB_REPOSITORY");
  if (!eventPath) throw new Error("Missing GITHUB_EVENT_PATH");

  const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  const prNumber = event?.pull_request?.number;

  if (!prNumber) {
    throw new Error("This workflow must run on pull_request events (no PR found).");
  }

  // Build diff (keep it small-ish)
  // For PR runs, origin/<base_ref> should exist after checkout with fetch-depth: 0
  const baseRef = event.pull_request.base.ref;
  const headSha = event.pull_request.head.sha;

  // Ensure we have base ref locally
  // (ignore errors if already fetched)
  try {
    execSync(`git fetch origin ${baseRef} --depth=1`, { stdio: "ignore" });
  } catch {}

  let diffText = "";
  try {
    diffText = execSync(`git diff origin/${baseRef}...${headSha}`, { encoding: "utf8" });
  } catch (e) {
    // fallback
    diffText = execSync(`git diff origin/${baseRef}...HEAD`, { encoding: "utf8" });
  }

  // Avoid giant payloads
  const MAX_CHARS = 12000;
  if (diffText.length > MAX_CHARS) diffText = diffText.slice(0, MAX_CHARS) + "\n\n[Diff truncated]\n";

  const prompt = `
Você é um revisor sênior de código. Revise as mudanças do Pull Request.

Regras:
- Seja objetivo.
- Aponte: bugs prováveis, edge cases, melhorias de qualidade, segurança, performance e legibilidade.
- Se possível, sugira trechos de código corrigidos.
- Organize em tópicos.
- Se não houver problemas, diga que está ok.

Aqui está o diff (pode estar truncado):
${diffText}
`.trim();

  const review = await callOpenAI(prompt, OPENAI_API_KEY);

  // Post comment on PR (Issue comments endpoint)
  await postPRComment(repo, prNumber, review, GITHUB_TOKEN);

  console.log("✅ AI review comment posted successfully.");
}

async function callOpenAI(prompt, apiKey) {
  // Using Responses API (recommended)
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI API error (${res.status}): ${txt}`);
  }

  const data = await res.json();

  // Extract output text safely
  const text =
    data?.output?.[0]?.content?.find((c) => c?.type === "output_text")?.text ||
    data?.output_text ||
    JSON.stringify(data, null, 2);

  // Keep comment reasonable size
  return `## 🤖 AI Code Review\n\n${text}`.slice(0, 65000);
}

async function postPRComment(repo, prNumber, body, token) {
  const url = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GitHub comment error (${res.status}): ${txt}`);
  }
}

main().catch((err) => {
  console.error("❌ ERROR:", err.message);
  process.exit(1);
});
