// Generates two static SVG cards for the GitHub profile README:
//   profile/stats.svg      — stars, commits, PRs, issues, contributions, followers
//   profile/top-langs.svg  — top languages by bytes across public, non-fork repos
//
// Runs entirely on GitHub's REST + GraphQL APIs via Node's built-in fetch.
// No third-party npm dependencies, no external rendering service — everything
// is generated and committed locally by the workflow that calls this script.

const USERNAME = process.env.PROFILE_USERNAME;
const TOKEN = process.env.GITHUB_TOKEN;

if (!USERNAME) {
  console.error("Missing PROFILE_USERNAME env var.");
  process.exit(1);
}
if (!TOKEN) {
  console.error("Missing GITHUB_TOKEN env var.");
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  "User-Agent": "profile-stats-generator",
  Accept: "application/vnd.github+json",
};

async function graphql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`GraphQL request failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

async function restPaginated(url) {
  let results = [];
  let page = 1;
  while (true) {
    const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}per_page=100&page=${page}`, { headers });
    if (!res.ok) throw new Error(`REST request failed: ${res.status} ${await res.text()}`);
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    results = results.concat(batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return results;
}

// ---------------------------------------------------------------------------
// Fetch stats
// ---------------------------------------------------------------------------

async function fetchUserStats() {
  const query = `
    query ($login: String!) {
      user(login: $login) {
        name
        followers { totalCount }
        contributionsCollection {
          totalCommitContributions
          totalPullRequestContributions
          totalIssueContributions
          totalRepositoryContributions
        }
        repositories(ownerAffiliations: OWNER, isFork: false, first: 100) {
          totalCount
          nodes {
            stargazerCount
          }
        }
        pullRequests(states: MERGED) { totalCount }
      }
    }
  `;
  const data = await graphql(query, { login: USERNAME });
  const user = data.user;
  const totalStars = user.repositories.nodes.reduce((sum, r) => sum + r.stargazerCount, 0);

  return {
    name: user.name || USERNAME,
    followers: user.followers.totalCount,
    stars: totalStars,
    commits: user.contributionsCollection.totalCommitContributions,
    prs: user.contributionsCollection.totalPullRequestContributions,
    mergedPrs: user.pullRequests.totalCount,
    issues: user.contributionsCollection.totalIssueContributions,
    repos: user.repositories.totalCount,
  };
}

async function fetchTopLanguages() {
  const repos = await restPaginated(`https://api.github.com/users/${USERNAME}/repos?type=owner`);
  const nonForkRepos = repos.filter((r) => !r.fork);

  const totals = {};
  for (const repo of nonForkRepos) {
    try {
      const res = await fetch(`https://api.github.com/repos/${USERNAME}/${repo.name}/languages`, { headers });
      if (!res.ok) continue;
      const langs = await res.json();
      for (const [lang, bytes] of Object.entries(langs)) {
        totals[lang] = (totals[lang] || 0) + bytes;
      }
    } catch {
      // Skip repos whose language data fails to load rather than breaking the whole run.
    }
  }

  const sum = Object.values(totals).reduce((a, b) => a + b, 0) || 1;
  return Object.entries(totals)
    .map(([lang, bytes]) => ({ lang, pct: (bytes / sum) * 100 }))
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 6);
}

// ---------------------------------------------------------------------------
// SVG rendering — dark, GitHub-native, monospace, single accent color
// ---------------------------------------------------------------------------

const BG = "#0d1117";
const BORDER = "#30363d";
const TEXT = "#c9d1d9";
const MUTED = "#8b949e";
const ACCENT = "#58a6ff";
const FONT = "'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace";

function escapeXml(str) {
  return String(str).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
}

function renderStatsCard(stats) {
  const width = 480;
  const height = 190;
  const rows = [
    ["Commits (last year)", stats.commits],
    ["Pull requests", `${stats.prs} opened · ${stats.mergedPrs} merged`],
    ["Issues opened", stats.issues],
    ["Stars earned", stats.stars],
    ["Public repositories", stats.repos],
    ["Followers", stats.followers],
  ];

  const rowHeight = 20;
  const startY = 56;

  const rowsSvg = rows
    .map(
      (row, i) => `
    <text x="24" y="${startY + i * rowHeight}" fill="${MUTED}" font-size="13" font-family="${FONT}">${escapeXml(row[0])}</text>
    <text x="${width - 24}" y="${startY + i * rowHeight}" fill="${TEXT}" font-size="13" font-family="${FONT}" text-anchor="end">${escapeXml(row[1])}</text>`
    )
    .join("");

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="8" fill="${BG}" stroke="${BORDER}" />
  <text x="24" y="30" fill="${ACCENT}" font-size="14" font-family="${FONT}" font-weight="bold" letter-spacing="1">GITHUB STATS</text>
  <line x1="24" y1="40" x2="${width - 24}" y2="40" stroke="${BORDER}" />
  ${rowsSvg}
</svg>`;
}

function renderTopLangsCard(langs) {
  const width = 480;
  const rowHeight = 26;
  const startY = 56;
  const height = startY + langs.length * rowHeight + 16;
  const barMaxWidth = width - 190;

  const rowsSvg = langs
    .map((l, i) => {
      const y = startY + i * rowHeight;
      const barWidth = Math.max(2, (l.pct / 100) * barMaxWidth);
      return `
    <text x="24" y="${y}" fill="${TEXT}" font-size="13" font-family="${FONT}">${escapeXml(l.lang)}</text>
    <rect x="150" y="${y - 11}" width="${barMaxWidth}" height="10" rx="5" fill="${BORDER}" />
    <rect x="150" y="${y - 11}" width="${barWidth}" height="10" rx="5" fill="${ACCENT}" />
    <text x="${width - 24}" y="${y}" fill="${MUTED}" font-size="12" font-family="${FONT}" text-anchor="end">${l.pct.toFixed(1)}%</text>`;
    })
    .join("");

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="8" fill="${BG}" stroke="${BORDER}" />
  <text x="24" y="30" fill="${ACCENT}" font-size="14" font-family="${FONT}" font-weight="bold" letter-spacing="1">TOP LANGUAGES</text>
  <line x1="24" y1="40" x2="${width - 24}" y2="40" stroke="${BORDER}" />
  ${rowsSvg}
</svg>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const fs = await import("node:fs/promises");

const [stats, langs] = await Promise.all([fetchUserStats(), fetchTopLanguages()]);

await fs.mkdir("profile", { recursive: true });
await fs.writeFile("profile/stats.svg", renderStatsCard(stats));
await fs.writeFile("profile/top-langs.svg", renderTopLangsCard(langs.length ? langs : [{ lang: "No data yet", pct: 0 }]));

console.log("Generated profile/stats.svg and profile/top-langs.svg");
