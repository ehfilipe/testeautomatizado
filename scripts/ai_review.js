/**
 * AI Code Review Bot (GitHub Actions)
 * Arquitetura profissional:
 * - Lê diff do PR via GitHub API
 * - Envia para OpenAI (GPT-4.1)
 * - Publica comentário no Pull Request
 */

const fetch = global.fetch;

// =======================
// Utilidades
// =======================

function requiredEnv(name, value) {
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
}

function truncate(text, max = 12000) {
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
- Aponte bugs, edge cases, segurança, performance e legibilidade
- Se possível, sugira código corrigido
- Se não houver problemas relevantes, diga que está OK

Diff do Pull Request (pode estar truncado):

${diffText}
`.trim();

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4.1",
      temperature: 0.2,
      messages: [
        { role: "system", content: "Você é um revisor de código experiente." },
        { role: "user", content: prompt }
      ]
    })
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

async function getPullRequestDiff({ github, context }) {
  const pr = context.payload.pull_request;
  if (!pr) {
    console.log("No pull request context. Skipping.");
    return null;
  }

  const files = await github.paginate(
    github.rest.pulls.listFiles,
    {
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: pr.number,
      per_page: 100
    }
  );

  const patches = files
    .filter(f => f.patch)
    .map(f => {
      return `
FILE: ${f.filename}
STATUS: ${f.status}
PATCH:
${f.patch}
`;
    })
    .join("\n---\n");

  if (!patches.trim()) {
    return null;
  }

  return truncate(patches);
}

async function postComment({ github, context, body }) {
  const pr = context.payload.pull_request;

  await github.rest.issues.createComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: pr.number,
    body
  });
}

// =======================
// Main
// =======================

async function main({ github, context, core }) {
  try {
    const diffText = await getPullRequestDiff({ github, context });

    if (!diffText) {
      core.info("No diff found to review.");
      return;
    }

    const review = await callOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      diffText
    });

    const comment = `
## 🤖 AI Code TRADIO Review

${review}

---

_Obs: revisão automática baseada no diff do PR (pode estar truncado)._
`;

    await postComment({ github, context, body: comment });

    core.info("AI review comment posted successfully.");
  } catch (error) {
    core.setFailed(error.message);
  }
}

module.exports = main;
