/**
 * AI Code Review Bot (GitHub Actions)
 * Arquitetura profissional:
 * - Lê diff do PR via GitHub API
 * - Envia para OpenAI (GPT-4.1)
 * - Publica comentário no Pull Request
 *
 * Exporta uma função main({ github, context, core }) para ser chamada pelo actions/github-script.
 */

// =======================
// fetch (compatibilidade)
// =======================
async function getFetch() {
  // Node 18+ normalmente já tem fetch global (no seu workflow é Node 20).
  if (typeof global.fetch === "function") return global.fetch;

  // Fallback: tenta node-fetch (se estiver instalado)
  try {
    // node-fetch v3 é ESM; por isso usamos import dinâmico
    const mod = await import("node-fetch");
    return mod.default;
  } catch (e) {
    throw new Error(
      "fetch não está disponível neste ambiente. " +
        "Seu workflow deve usar Node >= 18 (ex: node-version: 20). " +
        "Alternativamente, instale 'node-fetch' e permita o import dinâmico."
    );
  }
}

// =======================
// Utilidades
// =======================
function requiredEnv(name, value) {
  if (!value) throw new Error(`Missing required env: ${name}`);
}

function ensureRepoContext(context) {
  if (
    !context ||
    !context.repo ||
    !context.repo.owner ||
    !context.repo.repo
  ) {
    throw new Error("context.repo está indefinido (owner/repo não encontrados).");
  }
}

function truncate(text, max = 12000) {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n\n... (diff truncado)";
}

// =======================
// OpenAI
// =======================
async function callOpenAI({ apiKey, diffText }) {
  requiredEnv("OPENAI_API_KEY", apiKey);

  const prompt = `
Você é um revisor sênior de código.

Regras:
- Seja objetivo
- Organize em tópicos
- Aponte: bugs prováveis, edge cases, melhorias de qualidade, segurança, performance e legibilidade
- Se possível, sugira trechos de código corrigidos
- Se não houver problemas relevantes, diga que está OK

Diff do Pull Request (pode estar truncado):

${diffText}
`.trim();

  const fetch = await getFetch();

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1",
      temperature: 0.2,
      messages: [
        { role: "system", content: "Você é um revisor de código experiente e criterioso." },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${err}`);
  }

  const data = await response.json();
  return data?.choices?.[0]?.message?.content?.trim() || "Não foi possível gerar a revisão.";
}

// =======================
// GitHub (Diff do PR)
// =======================
async function getPullRequestDiff({ github, context, core }) {
  const pr = context?.payload?.pull_request;

  if (!pr) {
    core?.info?.("No pull request context. Skipping.");
    return null;
  }

  // Se quiser ignorar PR em draft
  if (pr.draft) {
    core?.info?.("PR is draft. Skipping review.");
    return null;
  }

  ensureRepoContext(context);

  const owner = context.repo.owner;
  const repo = context.repo.repo;

  const files = await github.paginate(github.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pr.number,
    per_page: 100,
  });

  // Limites para evitar payload enorme
  const maxFiles = 15;
  const maxPatchCharsPerFile = 5000;

  const selected = files
    .filter((f) => f.patch) // ignora binários/grandes sem patch
    .slice(0, maxFiles);

  if (selected.length === 0) return null;

  const patches = selected
    .map((f) => {
      const patch =
        f.patch.length > maxPatchCharsPerFile
          ? f.patch.slice(0, maxPatchCharsPerFile) + "\n... (patch truncado)\n"
          : f.patch;

      return `FILE: ${f.filename}\nSTATUS: ${f.status}\nPATCH:\n${patch}\n`;
    })
    .join("\n---\n");

  if (!patches.trim()) return null;

  return truncate(patches, 12000);
}

async function postComment({ github, context, body }) {
  const pr = context?.payload?.pull_request;
  if (!pr) return;

  ensureRepoContext(context);

  await github.rest.issues.createComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: pr.number,
    body,
  });
}

// =======================
// Main (export)
// =======================
async function main({ github, context, core }) {
  try {
    ensureRepoContext(context);

    const diffText = await getPullRequestDiff({ github, context, core });

    if (!diffText) {
      core.info("No diff found to review.");
      return;
    }

    const review = await callOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      diffText,
    });

    const truncatedNote = diffText.includes("... (diff truncado)")
      ? `\n\n⚠️ O diff analisado foi truncado (máx. 12000 caracteres).`
      : "";

    const comment = `## 🤖 AI Code TRADIO Review

${review}
${truncatedNote}

---

_Obs: revisão automática baseada no diff do PR (pode estar truncado)._`;

    await postComment({ github, context, body: comment });

    core.info("AI review comment posted successfully.");
  } catch (error) {
    core.setFailed(error?.message || String(error));
  }
}

module.exports = main;
