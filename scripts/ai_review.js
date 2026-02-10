/**
 * AI Code Review Bot (GitHub Actions) — Tradio
 * Arquitetura profissional:
 * - Lê diff do PR via GitHub API
 * - Envia para OpenAI (GPT-4.1)
 * - Publica comentário no Pull Request
 *
 * Melhorias aplicadas:
 * 1) Reuso da função truncate() para truncar patch por arquivo e diff total
 * 2) Aviso explícito no comentário quando houver truncamento (arquivos/patch/diff total)
 */

// Fetch compatível (Node >=18 tem fetch global; fallback tenta node-fetch)
let fetchFn = global.fetch;
if (!fetchFn) {
  try {
    // eslint-disable-next-line global-require
    fetchFn = require("node-fetch");
  } catch (e) {
    // Se não tiver node-fetch, o script vai falhar ao tentar chamar API
    fetchFn = null;
  }
}

// =======================
// Utilidades
// =======================

function requiredEnv(name, value) {
  if (!value) throw new Error(`Missing required env: ${name}`);
}

function ensureRepoContext(context) {
  if (!context?.repo?.owner || !context?.repo?.repo) {
    throw new Error("context.repo está indefinido (owner/repo).");
  }
}

function truncate(text, max) {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n\n... (truncado)";
}

// =======================
// OpenAI
// =======================

async function callOpenAI({ apiKey, diffText }) {
  requiredEnv("OPENAI_API_KEY", apiKey);
  if (!fetchFn) {
    throw new Error(
      "fetch não disponível neste runner. Instale 'node-fetch' ou use Node >= 18."
    );
  }

  const prompt = `
Você é um revisor sênior de código.

Regras:
- Seja objetivo
- Organize em tópicos
- Aponte bugs, edge cases, segurança, performance e legibilidade
- Se possível, sugira código corrigido
- Se não houver problemas relevantes, diga que está OK

Diff do Pull Request (pode estar truncado):

${diffText}
`.trim();

  const response = await fetchFn("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1",
      temperature: 0.2,
      messages: [
        { role: "system", content: "Você é um revisor de código experiente." },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${err}`);
  }

  const data = await response.json();
  return (
    data?.choices?.[0]?.message?.content?.trim() ||
    "Não foi possível gerar a revisão."
  );
}

// =======================
// GitHub
// =======================

async function getPullRequestDiff({ github, context, core }) {
  const pr = context.payload.pull_request;
  if (!pr) {
    core?.info?.("No pull request context. Skipping.");
    return { diffText: null, meta: null };
  }

  if (pr.draft) {
    core?.info?.("PR is draft. Skipping review.");
    return { diffText: null, meta: { skippedDraft: true } };
  }

  ensureRepoContext(context);

  const files = await github.paginate(github.rest.pulls.listFiles, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: pr.number,
    per_page: 100,
  });

  // Limites (produção-friendly)
  const maxFiles = 15;
  const maxPatchCharsPerFile = 5000;
  const maxTotalChars = 12000;

  const filesWithPatch = files.filter((f) => f.patch);

  const selected = filesWithPatch.slice(0, maxFiles);

  if (selected.length === 0) {
    core?.info?.("No text patches found to review.");
    return { diffText: null, meta: { noPatches: true } };
  }

  // Flags de truncamento
  const truncated = {
    filesLimited: filesWithPatch.length > maxFiles,
    patchTruncatedCount: 0,
    totalTruncated: false,
    maxFiles,
    maxPatchCharsPerFile,
    maxTotalChars,
    filesWithPatchCount: filesWithPatch.length,
    selectedCount: selected.length,
  };

  const chunks = selected.map((f) => {
    const originalLen = f.patch.length;
    const patch = truncate(f.patch, maxPatchCharsPerFile);
    if (originalLen > maxPatchCharsPerFile) truncated.patchTruncatedCount += 1;

    return `FILE: ${f.filename}
STATUS: ${f.status}
PATCH:
${patch}
`;
  });

  let diffText = chunks.join("\n---\n").trim();

  // Se limitou arquivos, avisa dentro do próprio diff enviado ao modelo também
  if (truncated.filesLimited) {
    diffText += `\n\n... (apenas os primeiros ${maxFiles} arquivos com patch foram incluídos; total com patch: ${filesWithPatch.length})`;
  }

  // Trunca o diff total (segurança de payload)
  const beforeTotalLen = diffText.length;
  diffText = truncate(diffText, maxTotalChars);
  if (beforeTotalLen > maxTotalChars) truncated.totalTruncated = true;

  return { diffText, meta: truncated };
}

async function postComment({ github, context, body }) {
  ensureRepoContext(context);

  const pr = context.payload.pull_request;
  if (!pr) throw new Error("No pull request context to comment on.");

  await github.rest.issues.createComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: pr.number,
    body,
  });
}

// =======================
// Main (exportado para actions/github-script)
// =======================

async function main({ github, context, core }) {
  try {
    const { diffText, meta } = await getPullRequestDiff({ github, context, core });

    if (!diffText) {
      core.info("No diff found to review.");
      return;
    }

    const review = await callOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      diffText,
    });

    // Nota de truncamento no comentário (melhoria #2)
    let truncationNote = "";
    if (meta) {
      const notes = [];
      if (meta.filesLimited) {
        notes.push(
          `- Foram analisados apenas os primeiros **${meta.maxFiles}** arquivos com patch (total com patch: **${meta.filesWithPatchCount}**).`
        );
      }
      if (meta.patchTruncatedCount > 0) {
        notes.push(
          `- **${meta.patchTruncatedCount}** patch(es) foram truncados para **${meta.maxPatchCharsPerFile}** caracteres.`
        );
      }
      if (meta.totalTruncated) {
        notes.push(
          `- O diff total foi truncado para **${meta.maxTotalChars}** caracteres.`
        );
      }

      if (notes.length) {
        truncationNote = `\n\n⚠️ **Aviso de truncamento**\n${notes.join("\n")}\n`;
      }
    }

    const comment = `## 🤖 AI Code TRADIO Review

${review}
${truncationNote}
---

_Obs: revisão automática baseada no diff do PR (pode estar truncado)._`;

    await postComment({ github, context, body: comment });

    core.info("AI review comment posted successfully.");
  } catch (error) {
    core.setFailed(error?.message || String(error));
  }
}

module.exports = main;
