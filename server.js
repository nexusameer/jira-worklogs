const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8080);
const JIRA_DOMAIN = process.env.JIRA_DOMAIN || "clustox.atlassian.net";
const JIRA_TIMEOUT_MS = Number(process.env.JIRA_TIMEOUT_MS || 90000);
const JIRA_MAX_RETRIES = Number(process.env.JIRA_MAX_RETRIES || 4);
const ISSUE_CONCURRENCY = Math.max(1, Number(process.env.ISSUE_CONCURRENCY || 4));
const REPORT_JOBS = new Map();

const PROJECT_LABELS = {
  CLUS: "clustox",
  EV: "emailverify",
  IW: "inboxwarmup",
  WCI: "wci",
  P3: "project 360",
  PSD: "psd",
  NB: "national bonds",
  UA: "urban assembly"
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt, retryAfterHeader) {
  const retryAfterSeconds = Number(retryAfterHeader);
  if (!Number.isNaN(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return retryAfterSeconds * 1000;
  }
  return 500 * Math.pow(2, attempt - 1);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(payload));
}

function sendFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: "File not found" });
      return;
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function jiraGet(url, authHeader) {
  return new Promise((resolve, reject) => {
    const runAttempt = (attempt) => {
      const req = https.request(
        url,
        {
          method: "GET",
          headers: {
            Authorization: authHeader,
            Accept: "application/json"
          },
          timeout: JIRA_TIMEOUT_MS
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });

          res.on("end", async () => {
            const statusCode = Number(res.statusCode || 0);
            const retriable = statusCode === 429 || (statusCode >= 500 && statusCode <= 599);

            if (retriable && attempt < JIRA_MAX_RETRIES) {
              const delay = retryDelayMs(attempt, res.headers["retry-after"]);
              await sleep(delay);
              runAttempt(attempt + 1);
              return;
            }

            if (statusCode < 200 || statusCode >= 300) {
              reject(new Error(`Jira API ${statusCode}: ${data.slice(0, 300)}`));
              return;
            }

            try {
              resolve(JSON.parse(data));
            } catch {
              reject(new Error("Jira API returned invalid JSON"));
            }
          });
        }
      );

      req.on("timeout", async () => {
        req.destroy();
        if (attempt < JIRA_MAX_RETRIES) {
          const delay = retryDelayMs(attempt);
          await sleep(delay);
          runAttempt(attempt + 1);
          return;
        }
        reject(new Error("Jira request timed out"));
      });

      req.on("error", async (err) => {
        if (attempt < JIRA_MAX_RETRIES) {
          const delay = retryDelayMs(attempt);
          await sleep(delay);
          runAttempt(attempt + 1);
          return;
        }
        reject(err);
      });

      req.end();
    };

    runAttempt(1);
  });
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) break;
      results[current] = await mapper(items[current], current);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function toMillis(dateTimeStr) {
  if (!dateTimeStr || typeof dateTimeStr !== "string") return NaN;
  const normalized = dateTimeStr.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  return Date.parse(normalized);
}

function secondsToHours(seconds) {
  return Number((seconds / 3600).toFixed(2));
}

function normalizeProjectKeys(projectsInput) {
  const DEFAULT_PROJECTS = ["CLUS", "EV", "IW", "WCI", "P3", "PSD", "NB", "UA"];
  if (!projectsInput) return DEFAULT_PROJECTS;

  let raw = [];
  if (Array.isArray(projectsInput)) {
    raw = projectsInput;
  } else if (typeof projectsInput === "string") {
    raw = projectsInput.split(",");
  }

  const unique = [];
  const seen = new Set();
  for (const item of raw) {
    const key = String(item || "").trim().toUpperCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(key);
  }
  return unique.length ? unique : DEFAULT_PROJECTS;
}

function emptyProjectSeconds(projectKeys) {
  const totals = {};
  for (const key of projectKeys) {
    const label = PROJECT_LABELS[key] || key.toLowerCase();
    totals[label] = 0;
  }
  return totals;
}

function mapSecondsToHours(projectSeconds) {
  const projectHours = {};
  for (const [project, seconds] of Object.entries(projectSeconds)) {
    projectHours[project] = secondsToHours(seconds);
  }
  return projectHours;
}

function extractCommentText(comment) {
  if (!comment || !Array.isArray(comment.content)) return "";
  const parts = [];

  function walk(node) {
    if (!node) return;
    if (node.type === "text" && typeof node.text === "string") {
      parts.push(node.text);
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) walk(child);
    }
  }

  for (const node of comment.content) {
    walk(node);
  }

  return parts.join(" ").trim();
}

async function fetchMyself(authHeader) {
  const url = `https://${JIRA_DOMAIN}/rest/api/3/myself`;
  return jiraGet(url, authHeader);
}

async function fetchAccessibleProjects(authHeader) {
  const projects = [];
  let startAt = 0;
  const maxResults = 100;

  while (true) {
    const url = `https://${JIRA_DOMAIN}/rest/api/3/project/search?startAt=${startAt}&maxResults=${maxResults}`;
    const data = await jiraGet(url, authHeader);
    const values = Array.isArray(data.values) ? data.values : [];

    for (const p of values) {
      if (!p || !p.key) continue;
      projects.push({ key: p.key, name: String(p.name || p.key) });
    }

    startAt += values.length;
    if (!values.length || startAt >= Number(data.total || 0)) {
      break;
    }
  }

  projects.sort((a, b) => a.key.localeCompare(b.key));
  return projects;
}

async function buildBootstrap(payload) {
  const email = String(payload.email || "").trim();
  const token = String(payload.token || "").trim();

  if (!email || !token) {
    throw new Error("Email and token are required");
  }

  const authHeader = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
  const [myself, projects] = await Promise.all([
    fetchMyself(authHeader),
    fetchAccessibleProjects(authHeader)
  ]);

  return {
    domain: JIRA_DOMAIN,
    user: {
      displayName: String(myself.displayName || ""),
      accountId: String(myself.accountId || ""),
      emailAddress: String(myself.emailAddress || email)
    },
    projects
  };
}

async function fetchProjectIssueKeys(authHeader, projectKey) {
  const keySet = new Set();
  const jql = encodeURIComponent(`project=${projectKey}`);
  const maxResults = 100;
  let startAt = 0;

  while (true) {
    const url = `https://${JIRA_DOMAIN}/rest/api/3/search/jql?jql=${jql}&fields=key&startAt=${startAt}&maxResults=${maxResults}`;
    const data = await jiraGet(url, authHeader);
    const issues = Array.isArray(data.issues) ? data.issues : [];

    for (const issue of issues) {
      if (issue && issue.key) {
        keySet.add(issue.key);
      }
    }

    startAt += issues.length;
    if (!issues.length || startAt >= (data.total || 0)) {
      break;
    }
  }

  return Array.from(keySet);
}

async function fetchIssueWorklogs(authHeader, issueKey) {
  const logs = [];
  let startAt = 0;
  const maxResults = 100;

  while (true) {
    const url = `https://${JIRA_DOMAIN}/rest/api/3/issue/${encodeURIComponent(issueKey)}/worklog?startAt=${startAt}&maxResults=${maxResults}`;
    const data = await jiraGet(url, authHeader);
    const worklogs = Array.isArray(data.worklogs) ? data.worklogs : [];
    logs.push(...worklogs);

    startAt += worklogs.length;
    if (!worklogs.length || startAt >= (data.total || 0)) {
      break;
    }
  }

  return logs;
}

function updateJobProgress(job, patch) {
  Object.assign(job.progress, patch);
}

function appendJobLog(job, message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  job.logs.push(line);
  if (job.logs.length > 300) {
    job.logs.splice(0, job.logs.length - 300);
  }
}

async function buildReport(payload, onProgress) {
  const email = String(payload.email || "").trim();
  const token = String(payload.token || "").trim();
  const name = String(payload.name || "").trim();
  const accountId = String(payload.accountId || "").trim();
  const startDate = String(payload.startDate || "").trim();
  const endDate = String(payload.endDate || "").trim();
  const projectKeys = normalizeProjectKeys(payload.projects);

  if (!email || !token || !name || !accountId || !startDate || !endDate) {
    throw new Error("Missing required fields");
  }

  const authHeader = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
  const startMs = toMillis(`${startDate}T00:00:00.000+0500`);
  const endMs = toMillis(`${endDate}T23:59:59.999+0500`);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || startMs > endMs) {
    throw new Error("Invalid date range");
  }

  const projectSeconds = emptyProjectSeconds(projectKeys);
  const matchedWorklogs = [];

  onProgress({ phase: "start", message: "Starting report generation", currentProject: null });

  for (const projectKey of projectKeys) {
    onProgress({
      phase: "project-start",
      currentProject: projectKey,
      message: `Loading issues for ${projectKey}`,
      processedIssues: 0,
      totalIssues: 0
    });

    const issueKeys = await fetchProjectIssueKeys(authHeader, projectKey);
    const projectLabel = PROJECT_LABELS[projectKey] || projectKey.toLowerCase();
    let processedIssues = 0;

    onProgress({
      phase: "project-start",
      currentProject: projectKey,
      message: `Processing ${issueKeys.length} issues in ${projectKey}`,
      processedIssues,
      totalIssues: issueKeys.length
    });

    await mapWithConcurrency(issueKeys, ISSUE_CONCURRENCY, async (issueKey) => {
      const worklogs = await fetchIssueWorklogs(authHeader, issueKey);

      for (const log of worklogs) {
        const authorId = (log.author && log.author.accountId) || "";
        if (authorId !== accountId) continue;

        const started = String(log.started || "");
        const startedMs = toMillis(started);
        if (Number.isNaN(startedMs)) continue;
        if (startedMs < startMs || startedMs > endMs) continue;

        const seconds = Number(log.timeSpentSeconds || 0);
        if (!seconds) continue;

        projectSeconds[projectLabel] += seconds;
        matchedWorklogs.push({
          issueKey,
          projectKey,
          project: projectLabel,
          started,
          timeSpent: String(log.timeSpent || ""),
          timeSpentSeconds: seconds,
          comment: extractCommentText(log.comment)
        });
      }

      processedIssues += 1;
      if (
        processedIssues === issueKeys.length ||
        processedIssues === 1 ||
        processedIssues % 10 === 0
      ) {
        onProgress({
          phase: "project-progress",
          currentProject: projectKey,
          message: `Processed ${processedIssues}/${issueKeys.length} issues in ${projectKey}`,
          processedIssues,
          totalIssues: issueKeys.length
        });
      }
    });

    onProgress({
      phase: "project-done",
      currentProject: projectKey,
      message: `Completed ${projectKey}`,
      processedIssues: issueKeys.length,
      totalIssues: issueKeys.length
    });
  }

  matchedWorklogs.sort((a, b) => toMillis(a.started) - toMillis(b.started));

  const totalSeconds = Object.values(projectSeconds).reduce((a, b) => a + b, 0);
  return {
    domain: JIRA_DOMAIN,
    name,
    accountId,
    email,
    startDate,
    endDate,
    projects: projectKeys,
    projectSeconds,
    projectHours: mapSecondsToHours(projectSeconds),
    totalSeconds,
    totalHours: secondsToHours(totalSeconds),
    worklogs: matchedWorklogs
  };
}

function startReportJob(payload) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id,
    createdAt: Date.now(),
    done: false,
    error: null,
    result: null,
    logs: [],
    progress: {
      phase: "queued",
      currentProject: null,
      processedIssues: 0,
      totalIssues: 0,
      message: "Queued"
    }
  };

  REPORT_JOBS.set(id, job);

  (async () => {
    try {
      appendJobLog(job, "Job started");
      job.result = await buildReport(payload, (evt) => {
        updateJobProgress(job, {
          phase: evt.phase || job.progress.phase,
          currentProject: evt.currentProject ?? job.progress.currentProject,
          processedIssues: Number(evt.processedIssues ?? job.progress.processedIssues),
          totalIssues: Number(evt.totalIssues ?? job.progress.totalIssues),
          message: evt.message || job.progress.message
        });
        if (evt.message) appendJobLog(job, evt.message);
      });
      updateJobProgress(job, {
        phase: "done",
        message: "Report completed"
      });
      appendJobLog(job, "Report completed");
    } catch (err) {
      job.error = err.message || "Failed to build report";
      updateJobProgress(job, {
        phase: "error",
        message: job.error
      });
      appendJobLog(job, `Error: ${job.error}`);
    } finally {
      job.done = true;
    }
  })();

  return id;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    sendFile(res, path.join(__dirname, "index.html"), "text/html; charset=utf-8");
    return;
  }

  if (req.method === "POST" && req.url === "/api/report") {
    try {
      const payload = await parseBody(req);
      const report = await buildReport(payload);
      sendJson(res, 200, report);
    } catch (err) {
      sendJson(res, 400, { error: err.message || "Failed to build report" });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/report/start") {
    try {
      const payload = await parseBody(req);
      const jobId = startReportJob(payload);
      sendJson(res, 200, { jobId });
    } catch (err) {
      sendJson(res, 400, { error: err.message || "Failed to start report" });
    }
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/api/report/status")) {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const jobId = String(requestUrl.searchParams.get("jobId") || "").trim();
    if (!jobId) {
      sendJson(res, 400, { error: "jobId is required" });
      return;
    }

    const job = REPORT_JOBS.get(jobId);
    if (!job) {
      sendJson(res, 404, { error: "Job not found" });
      return;
    }

    sendJson(res, 200, {
      done: job.done,
      error: job.error,
      progress: job.progress,
      logs: job.logs,
      result: job.done && !job.error ? job.result : null
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/bootstrap") {
    try {
      const payload = await parseBody(req);
      const bootstrap = await buildBootstrap(payload);
      sendJson(res, 200, bootstrap);
    } catch (err) {
      sendJson(res, 400, { error: err.message || "Failed to load profile/projects" });
    }
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
