const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const POLL_INTERVAL_MS = 2_000;
const MAX_BACKOFF_MS = 30_000;
const MAX_EVENT_ROWS = 2_000;

let readCapability;
let appRoot;
let connectionState;
let activeView = { generation: 0, timer: undefined };
let reloadCurrentView = () => {};

export function parseBootstrapToken(fragment) {
  if (typeof fragment !== "string") return null;
  const candidate = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  return TOKEN_PATTERN.test(candidate) ? candidate : null;
}

export function consumeBootstrapToken(locationValue, historyValue) {
  const fragment = String(locationValue?.hash ?? "");
  const token = parseBootstrapToken(fragment);
  if (fragment.length > 0) historyValue.replaceState(null, "", "/");
  return token;
}

export function advanceCursor(previous, page) {
  if (Array.isArray(page?.events) && page.events.length > 0) {
    return page.events.reduce(
      (maximum, event) =>
        Number.isSafeInteger(event?.seq)
          ? Math.max(maximum, event.seq)
          : maximum,
      previous,
    );
  }
  if (page?.hasMore === true) return previous;
  return Number.isSafeInteger(page?.currentSeq)
    ? Math.max(previous, page.currentSeq)
    : previous;
}

export function nextBackoff(current, succeeded = false) {
  if (succeeded) return POLL_INTERVAL_MS;
  const base = Number.isFinite(current)
    ? Math.max(POLL_INTERVAL_MS, current)
    : POLL_INTERVAL_MS;
  return Math.min(MAX_BACKOFF_MS, base * 2);
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function containsOmission(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return false;
  if (Array.isArray(value))
    return value.some((entry) => containsOmission(entry, depth + 1));
  if (typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, entry]) =>
      (/unavailable|omitted|excluded/i.test(key) &&
        (entry === true || typeof entry === "string")) ||
      containsOmission(entry, depth + 1),
  );
}

export function classifyContent(record) {
  const badges = [];
  const capture = object(record?.capture);
  const redaction = object(record?.redaction);
  const counts = object(redaction.counts);
  if (capture.contentMode === "metadata") badges.push("metadata-only");
  if (capture.contentMode === "disabled") badges.push("disabled");
  if (Object.values(counts).some((count) => Number(count) > 0))
    badges.push("redacted");
  if (capture.truncated === true) badges.push("truncated");
  if (capture.unavailable === true || record?.payload === null)
    badges.push("unavailable");
  if (containsOmission(record?.payload)) badges.push("omitted");
  if (
    record?.kind === "artifact.recovered" ||
    record?.recoveredFromArtifact === true
  ) {
    badges.push("recovered");
  }
  return [...new Set(badges)];
}

function element(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function appendBadges(doc, parent, badges) {
  if (!badges || badges.length === 0) return;
  const group = element(doc, "div", "badges");
  for (const badge of badges) {
    const tone = /failed|error|unavailable|disabled/.test(badge)
      ? " error"
      : /truncated|omitted|stale|metadata/.test(badge)
        ? " warning"
        : /completed|done|recovered/.test(badge)
          ? " success"
          : "";
    group.append(element(doc, "span", `badge${tone}`, badge));
  }
  parent.append(group);
}

export function renderRow(doc, descriptor) {
  const row = element(doc, "article", descriptor.className ?? "event-row");
  const header = element(doc, "div", "event-header");
  header.append(element(doc, "strong", "", descriptor.title ?? "Event"));
  if (descriptor.meta)
    header.append(element(doc, "span", "event-time", descriptor.meta));
  row.append(header);
  appendBadges(doc, row, descriptor.badges ?? []);
  if (descriptor.summary)
    row.append(element(doc, "p", "meta", descriptor.summary));
  if (descriptor.content !== undefined) {
    row.append(element(doc, "pre", "", descriptor.content));
  }
  return row;
}

class ApiFailure extends Error {
  constructor(status, code, details) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function api(path) {
  const response = await fetch(path, {
    method: "GET",
    headers: { Authorization: `Bearer ${readCapability}` },
    credentials: "omit",
    mode: "same-origin",
    cache: "no-store",
    redirect: "error",
    referrerPolicy: "no-referrer",
  });
  let body;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const code =
      typeof body?.error === "string" ? body.error : `http-${response.status}`;
    throw new ApiFailure(response.status, code, body);
  }
  return body;
}

function setConnection(text, tone = "") {
  connectionState.textContent = text;
  connectionState.className = tone
    ? `connection-state ${tone}`
    : "connection-state";
}

function setNavigation(view) {
  for (const button of document.querySelectorAll("[data-view]")) {
    if (button.dataset.view === view)
      button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
}

function cancelPolling() {
  activeView.generation++;
  if (activeView.timer !== undefined) clearTimeout(activeView.timer);
  activeView.timer = undefined;
}

function schedulePolling(task) {
  if (activeView.timer !== undefined) clearTimeout(activeView.timer);
  const generation = activeView.generation;
  let delay = POLL_INTERVAL_MS;
  let inFlight = false;
  const schedule = () => {
    if (generation !== activeView.generation) return;
    activeView.timer = setTimeout(tick, delay);
  };
  const tick = async () => {
    if (generation !== activeView.generation) return;
    if (document.hidden || inFlight) {
      schedule();
      return;
    }
    inFlight = true;
    try {
      await task(generation);
      if (generation !== activeView.generation) return;
      delay = nextBackoff(delay, true);
      setConnection("Connected · read-only", "success");
    } catch (error) {
      if (generation !== activeView.generation) return;
      delay = nextBackoff(delay, false);
      if (error instanceof ApiFailure && error.status === 401) {
        setConnection("Read capability expired", "error");
        renderFatal(
          "Read capability required",
          "The local daemon restarted or the capability is invalid. Run /observability again.",
        );
        cancelPolling();
        return;
      }
      setConnection("Connection interrupted · retrying", "error");
    } finally {
      inFlight = false;
    }
    schedule();
  };
  schedule();
}

function statePanel(title, message, kind = "") {
  const section = element(
    document,
    "section",
    `state-panel${kind ? ` ${kind}` : ""}`,
  );
  section.append(element(document, "h2", "", title));
  section.append(element(document, "p", "", message));
  return section;
}

function replaceApp(node) {
  appRoot.replaceChildren(node);
  appRoot.focus({ preventScroll: true });
}

function renderLoading(label) {
  replaceApp(statePanel("Loading", label));
}

function renderFatal(title, message) {
  replaceApp(statePanel(title, message, "error"));
}

function formatTime(value) {
  if (!Number.isFinite(value)) return "unknown";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "unknown";
  }
}

function formatDuration(started, settled) {
  if (!Number.isFinite(started)) return "unknown";
  const end = Number.isFinite(settled) ? settled : Date.now();
  const milliseconds = Math.max(0, end - started);
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} s`;
  return `${(milliseconds / 60_000).toFixed(1)} min`;
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "unavailable";
  const units = ["B", "KiB", "MiB", "GiB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit++;
  }
  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function metadataGrid(entries) {
  const grid = element(document, "div", "meta-grid");
  for (const [label, value] of entries) {
    const pair = element(document, "div", "meta-pair");
    pair.append(element(document, "span", "meta-label", label));
    pair.append(
      element(document, "span", "meta-value", value ?? "unavailable"),
    );
    grid.append(pair);
  }
  return grid;
}

function runBadges(run) {
  const badges = [
    run.status,
    run.runKind,
    run.contentMode === "metadata" ? "metadata-only" : run.contentMode,
  ];
  if (run.recoveredFromArtifact) badges.push("recovered");
  if (run.metadata === null) badges.push("unavailable");
  if (run.errorText) badges.push("error");
  return badges.filter(Boolean);
}

function renderRunCard(run, openRun) {
  const card = element(document, "article", "run-card");
  const header = element(document, "div", "run-card-header");
  const title = element(document, "div");
  title.append(element(document, "h3", "", run.name ?? run.runId));
  title.append(element(document, "p", "meta", run.runId));
  const inspect = element(document, "button", "", "Open timeline");
  inspect.type = "button";
  inspect.addEventListener("click", () => openRun(run.runId));
  header.append(title, inspect);
  card.append(header);
  appendBadges(document, card, runBadges(run));
  card.append(
    metadataGrid([
      ["Project", run.projectRoot ?? run.projectId ?? "unattributed"],
      ["Started", formatTime(run.startedAtMs)],
      ["Duration", formatDuration(run.startedAtMs, run.settledAtMs)],
      ["Phase", run.currentPhase ?? "none"],
      ["Agents", String(run.agentCounts?.total ?? 0)],
      ["Last sequence", String(run.lastSeq)],
    ]),
  );
  if (run.errorText)
    card.append(element(document, "p", "error-text", run.errorText));
  return card;
}

function queryString(values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== "")
      params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

async function showRuns(initialFilters = {}) {
  cancelPolling();
  const generation = activeView.generation;
  setNavigation("runs");
  renderLoading("Loading run projections…");
  const state = {
    filters: {
      projectId: initialFilters.projectId ?? "",
      status: initialFilters.status ?? "",
      kind: initialFilters.kind ?? "",
    },
    runs: [],
    nextCursor: null,
    currentSeq: -1,
    stale: false,
  };

  const loadPage = async (append = false) => {
    const cursor = append ? state.nextCursor : null;
    const page = await api(
      `/v1/runs${queryString({
        ...state.filters,
        ...(cursor ?? {}),
        limit: 50,
      })}`,
    );
    if (generation !== activeView.generation) return;
    state.runs = append ? [...state.runs, ...page.runs] : page.runs;
    state.nextCursor = page.nextCursor;
    state.currentSeq = page.currentSeq;
    renderRunsState(state);
  };

  reloadCurrentView = () => showRuns(state.filters);
  try {
    await loadPage(false);
    if (generation !== activeView.generation) return;
    setConnection("Connected · read-only", "success");
  } catch (error) {
    if (generation !== activeView.generation) return;
    handleViewError(error, () => showRuns(state.filters));
    return;
  }
  schedulePolling(async (pollingGeneration) => {
    try {
      const snapshot = await api(
        `/v1/runs${queryString({ ...state.filters, limit: 50 })}`,
      );
      if (pollingGeneration !== activeView.generation) return;
      const wasStale = state.stale;
      const advanced = snapshot.currentSeq > state.currentSeq;
      state.stale = false;
      if (advanced) {
        state.runs = snapshot.runs;
        state.nextCursor = snapshot.nextCursor;
        state.currentSeq = snapshot.currentSeq;
      }
      if (advanced || wasStale) renderRunsState(state);
    } catch (error) {
      if (pollingGeneration !== activeView.generation) return;
      if (!state.stale) {
        state.stale = true;
        renderRunsState(state);
      }
      throw error;
    }
  });

  function renderRunsState(current) {
    const section = element(document, "section", "panel");
    const header = element(document, "div", "detail-header");
    const heading = element(document, "div");
    heading.append(element(document, "h2", "", "Runs"));
    heading.append(
      element(
        document,
        "p",
        "meta",
        `Projection watermark ${current.currentSeq}; retained floor supplied by the daemon.`,
      ),
    );
    header.append(heading);
    section.append(header);
    if (current.stale) appendBadges(document, section, ["stale snapshot"]);

    const toolbar = element(document, "div", "toolbar");
    const projectField = filterField(
      "Project ID",
      "input",
      current.filters.projectId,
    );
    const statusField = filterField(
      "Status",
      "select",
      current.filters.status,
      ["", "running", "completed", "failed", "aborted", "unknown"],
    );
    const kindField = filterField("Kind", "select", current.filters.kind, [
      "",
      "workflow",
      "standalone",
      "session",
      "unknown",
    ]);
    const apply = element(document, "button", "", "Apply filters");
    apply.type = "button";
    apply.addEventListener("click", () => {
      void showRuns({
        projectId: projectField.control.value.trim(),
        status: statusField.control.value,
        kind: kindField.control.value,
      });
    });
    toolbar.append(projectField.node, statusField.node, kindField.node, apply);
    section.append(toolbar);

    if (current.runs.length === 0) {
      section.append(
        element(
          document,
          "p",
          "empty-note",
          "No runs match the current filters.",
        ),
      );
    } else {
      const list = element(document, "div", "run-list");
      for (const run of current.runs)
        list.append(renderRunCard(run, (id) => void showRun(id)));
      section.append(list);
    }
    if (current.nextCursor) {
      const actions = element(document, "div", "actions");
      const more = element(document, "button", "", "Load more runs");
      more.type = "button";
      more.addEventListener("click", async () => {
        more.disabled = true;
        try {
          await loadPage(true);
        } catch (error) {
          handleViewError(error, () => showRuns(current.filters));
        }
      });
      actions.append(more);
      section.append(actions);
    }
    replaceApp(section);
  }
}

function filterField(label, type, selected, values = []) {
  const node = element(document, "label", "field");
  node.append(element(document, "span", "", label));
  const control = element(document, type);
  control.id = `filter-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  control.name = control.id;
  node.htmlFor = control.id;
  if (type === "input") {
    control.type = "text";
    control.maxLength = 256;
    control.value = selected;
    control.autocomplete = "off";
    control.spellcheck = false;
  } else {
    for (const value of values) {
      const option = element(document, "option", "", value || "All");
      option.value = value;
      option.selected = value === selected;
      control.append(option);
    }
  }
  node.append(control);
  return { node, control };
}

function laneName(event, agents) {
  if (event.ids?.agentId) {
    const agent = agents.find(
      (candidate) => candidate.agentId === event.ids.agentId,
    );
    return `Agent · ${agent?.localId ?? agent?.title ?? event.ids.agentId}`;
  }
  if (event.kind.startsWith("workflow.")) return "Workflow";
  return "Parent session";
}

function printablePayload(payload) {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return "Stored excerpt unavailable";
  }
}

function renderEvent(event) {
  return renderRow(document, {
    title: `${event.seq} · ${event.kind}`,
    meta: formatTime(event.occurredAtMs ?? event.receivedAtMs),
    badges: classifyContent(event),
    summary: event.ids?.turnId ? `Turn ${event.ids.turnId}` : undefined,
    content:
      event.payload === null
        ? "Stored excerpt unavailable"
        : printablePayload(event.payload),
  });
}

async function collectInitialEvents(path, generation) {
  let page = await api(`${path}?limit=500`);
  if (generation !== activeView.generation) throw new Error("view-cancelled");
  const events = [...page.events];
  let cursor = advanceCursor(0, page);
  let dropped = 0;
  while (page.hasMore && events.length < MAX_EVENT_ROWS) {
    page = await api(`${path}?afterSeq=${cursor}&limit=500`);
    if (generation !== activeView.generation) throw new Error("view-cancelled");
    events.push(...page.events);
    cursor = advanceCursor(cursor, page);
  }
  if (events.length > MAX_EVENT_ROWS) {
    dropped = events.length - MAX_EVENT_ROWS;
    events.splice(0, dropped);
  }
  return {
    events,
    cursor,
    currentSeq: Math.max(page.currentSeq, cursor),
    dropped,
    hasMore: page.hasMore,
  };
}

async function showRun(runId, staleReloaded = false) {
  cancelPolling();
  const generation = activeView.generation;
  setNavigation("");
  renderLoading("Loading run timeline and agent lanes…");
  reloadCurrentView = () => showRun(runId);
  let detail;
  let eventState;
  try {
    [detail, eventState] = await Promise.all([
      api(`/v1/runs/${encodeURIComponent(runId)}`),
      collectInitialEvents(
        `/v1/runs/${encodeURIComponent(runId)}/events`,
        generation,
      ),
    ]);
    if (generation !== activeView.generation) return;
  } catch (error) {
    if (generation !== activeView.generation) return;
    if (error instanceof ApiFailure && error.status === 410) {
      await showRun(runId, true);
      return;
    }
    handleViewError(error, () => showRun(runId));
    return;
  }
  renderRunDetail(detail, eventState, staleReloaded);
  setConnection("Connected · read-only", "success");
  schedulePolling(async (pollingGeneration) => {
    try {
      const page = await api(
        `/v1/runs/${encodeURIComponent(runId)}/events?afterSeq=${eventState.cursor}&limit=500`,
      );
      if (pollingGeneration !== activeView.generation) return;
      if (page.events.length > 0) {
        eventState.events.push(...page.events);
        if (eventState.events.length > MAX_EVENT_ROWS) {
          const removed = eventState.events.length - MAX_EVENT_ROWS;
          eventState.events.splice(0, removed);
          eventState.dropped += removed;
        }
      }
      eventState.cursor = advanceCursor(eventState.cursor, page);
      eventState.currentSeq = Math.max(
        eventState.currentSeq,
        page.currentSeq,
        eventState.cursor,
      );
      if (page.events.length > 0) {
        detail = await api(`/v1/runs/${encodeURIComponent(runId)}`);
        if (pollingGeneration !== activeView.generation) return;
        renderRunDetail(detail, eventState, staleReloaded);
      }
    } catch (error) {
      if (pollingGeneration !== activeView.generation) return;
      if (error instanceof ApiFailure && error.status === 410) {
        setConnection("Stale cursor · reloading projection", "warning");
        await showRun(runId, true);
        return;
      }
      throw error;
    }
  });
}

function renderRunDetail(detail, eventState, staleReloaded) {
  const section = element(document, "section", "panel");
  const header = element(document, "div", "detail-header");
  const heading = element(document, "div");
  heading.append(element(document, "p", "eyebrow", "Run timeline"));
  heading.append(
    element(document, "h2", "", detail.run.name ?? detail.run.runId),
  );
  heading.append(element(document, "p", "meta", detail.run.runId));
  const back = element(document, "button", "", "Back to runs");
  back.type = "button";
  back.addEventListener("click", () => void showRuns());
  header.append(heading, back);
  section.append(header);
  appendBadges(document, section, [
    ...runBadges(detail.run),
    ...(staleReloaded ? ["stale cursor reloaded"] : []),
    ...(detail.agentsTruncated ? ["agent list truncated"] : []),
  ]);
  section.append(
    metadataGrid([
      [
        "Project",
        detail.run.projectRoot ?? detail.run.projectId ?? "unattributed",
      ],
      ["Status", detail.run.status],
      ["Phase", detail.run.currentPhase ?? "none"],
      ["Started", formatTime(detail.run.startedAtMs)],
      [
        "Duration",
        formatDuration(detail.run.startedAtMs, detail.run.settledAtMs),
      ],
      ["Current sequence", String(eventState.currentSeq)],
    ]),
  );
  if (eventState.dropped > 0 || eventState.hasMore) {
    section.append(
      element(
        document,
        "p",
        "empty-note",
        "Older events were dropped from this bounded in-memory view. Reload to resnapshot from the retained floor.",
      ),
    );
  }

  if (detail.agents.length > 0) {
    const actions = element(document, "div", "actions");
    for (const agent of detail.agents) {
      const button = element(
        document,
        "button",
        "",
        `Open ${agent.localId ?? agent.title ?? agent.agentId}`,
      );
      button.type = "button";
      button.addEventListener("click", () => void showAgent(agent.agentId));
      actions.append(button);
    }
    section.append(actions);
  }

  const laneMap = new Map();
  for (const event of eventState.events) {
    const name = laneName(event, detail.agents);
    if (!laneMap.has(name)) laneMap.set(name, []);
    laneMap.get(name).push(event);
  }
  if (laneMap.size === 0) {
    section.append(
      element(
        document,
        "p",
        "empty-note",
        "No retained events are available for this run.",
      ),
    );
  } else {
    const lanes = element(document, "div", "lanes");
    for (const [name, events] of laneMap) {
      const lane = element(document, "section", "lane");
      lane.append(element(document, "h3", "", name));
      const list = element(document, "div", "event-list");
      for (const event of events) list.append(renderEvent(event));
      lane.append(list);
      lanes.append(lane);
    }
    section.append(lanes);
  }
  replaceApp(section);
}

async function showAgent(agentId, staleReloaded = false) {
  cancelPolling();
  const generation = activeView.generation;
  setNavigation("");
  renderLoading("Loading agent detail and retained events…");
  reloadCurrentView = () => showAgent(agentId);
  let detail;
  let eventState;
  try {
    [detail, eventState] = await Promise.all([
      api(`/v1/agents/${encodeURIComponent(agentId)}`),
      collectInitialEvents(
        `/v1/agents/${encodeURIComponent(agentId)}/events`,
        generation,
      ),
    ]);
    if (generation !== activeView.generation) return;
  } catch (error) {
    if (generation !== activeView.generation) return;
    if (error instanceof ApiFailure && error.status === 410) {
      await showAgent(agentId, true);
      return;
    }
    handleViewError(error, () => showAgent(agentId));
    return;
  }
  renderAgentDetail(detail, eventState, staleReloaded);
  setConnection("Connected · read-only", "success");
  schedulePolling(async (pollingGeneration) => {
    try {
      const page = await api(
        `/v1/agents/${encodeURIComponent(agentId)}/events?afterSeq=${eventState.cursor}&limit=500`,
      );
      if (pollingGeneration !== activeView.generation) return;
      if (page.events.length > 0) {
        eventState.events.push(...page.events);
        if (eventState.events.length > MAX_EVENT_ROWS) {
          const removed = eventState.events.length - MAX_EVENT_ROWS;
          eventState.events.splice(0, removed);
          eventState.dropped += removed;
        }
        detail = await api(`/v1/agents/${encodeURIComponent(agentId)}`);
        if (pollingGeneration !== activeView.generation) return;
      }
      eventState.cursor = advanceCursor(eventState.cursor, page);
      eventState.currentSeq = Math.max(
        eventState.currentSeq,
        page.currentSeq,
        eventState.cursor,
      );
      if (page.events.length > 0)
        renderAgentDetail(detail, eventState, staleReloaded);
    } catch (error) {
      if (pollingGeneration !== activeView.generation) return;
      if (error instanceof ApiFailure && error.status === 410) {
        setConnection("Stale cursor · reloading projection", "warning");
        await showAgent(agentId, true);
        return;
      }
      throw error;
    }
  });
}

function renderAgentDetail(detail, eventState, staleReloaded) {
  const agent = detail.agent;
  const section = element(document, "section", "panel");
  const header = element(document, "div", "detail-header");
  const heading = element(document, "div");
  heading.append(element(document, "p", "eyebrow", "Agent detail"));
  heading.append(
    element(document, "h2", "", agent.title ?? agent.localId ?? agent.agentId),
  );
  heading.append(element(document, "p", "meta", agent.agentId));
  const run = element(document, "button", "", "Back to run timeline");
  run.type = "button";
  run.addEventListener("click", () => void showRun(agent.runId));
  header.append(heading, run);
  section.append(header);
  appendBadges(document, section, [
    agent.status,
    agent.origin,
    agent.backend,
    ...(agent.metadata === null ? ["unavailable"] : []),
    ...(agent.finalPreview ? [] : ["result unavailable"]),
    ...(staleReloaded ? ["stale cursor reloaded"] : []),
  ]);
  section.append(
    metadataGrid([
      ["Run", detail.run.name ?? detail.run.runId],
      ["Role", agent.role ?? "none"],
      ["Backend", agent.backend],
      ["Model", agent.model ?? "unavailable"],
      ["Native session", agent.nativeSessionId ?? "unavailable"],
      ["Working directory", agent.cwd ?? "unavailable"],
      ["Started", formatTime(agent.startedAtMs)],
      ["Duration", formatDuration(agent.startedAtMs, agent.settledAtMs)],
    ]),
  );
  if (agent.errorText)
    section.append(element(document, "p", "error-text", agent.errorText));
  if (agent.finalPreview) {
    section.append(
      renderRow(document, {
        title: "Bounded final preview",
        badges: ["stored excerpt"],
        content: agent.finalPreview,
      }),
    );
  }
  if (eventState.dropped > 0 || eventState.hasMore) {
    section.append(
      element(
        document,
        "p",
        "empty-note",
        "Older events were dropped from this bounded in-memory view.",
      ),
    );
  }
  const list = element(document, "div", "event-list");
  for (const event of eventState.events) list.append(renderEvent(event));
  if (eventState.events.length === 0) {
    section.append(
      element(
        document,
        "p",
        "empty-note",
        "No retained events are available for this agent.",
      ),
    );
  } else {
    section.append(list);
  }
  replaceApp(section);
}

function metricList(entries) {
  const list = element(document, "dl", "metric-list");
  for (const [label, value] of entries) {
    list.append(element(document, "dt", "", label));
    list.append(element(document, "dd", "", value));
  }
  return list;
}

async function showHealth() {
  cancelPolling();
  const generation = activeView.generation;
  setNavigation("health");
  renderLoading("Loading daemon and storage health…");
  reloadCurrentView = showHealth;
  let status;
  try {
    status = await api("/v1/status");
    if (generation !== activeView.generation) return;
  } catch (error) {
    if (generation !== activeView.generation) return;
    handleViewError(error, showHealth);
    return;
  }
  renderHealth(status);
  setConnection("Connected · read-only", "success");
  schedulePolling(async (pollingGeneration) => {
    const next = await api("/v1/status");
    if (pollingGeneration !== activeView.generation) return;
    if (
      next.currentSeq > status.currentSeq ||
      next.degraded !== status.degraded
    ) {
      status = next;
      renderHealth(status);
    }
  });
}

function renderHealth(status) {
  const section = element(document, "section", "panel");
  const header = element(document, "div", "detail-header");
  const heading = element(document, "div");
  heading.append(element(document, "p", "eyebrow", "System health"));
  heading.append(element(document, "h2", "", "Companion daemon"));
  heading.append(
    element(
      document,
      "p",
      "meta",
      "Live in-memory health plus bounded storage metadata.",
    ),
  );
  header.append(heading);
  section.append(header);
  appendBadges(document, section, [
    status.ready ? "ready" : "not ready",
    status.degraded ? "degraded" : "healthy",
    status.policy.capture === "metadata"
      ? "metadata-only"
      : status.policy.capture,
  ]);
  const grid = element(document, "div", "health-grid");
  const countEntries = (value) => {
    const entries = Object.entries(value ?? {}).map(([key, count]) => [
      key,
      String(count),
    ]);
    return entries.length > 0 ? entries : [["none", "0"]];
  };
  const cards = [
    [
      "Runtime",
      [
        ["Build", status.buildVersion],
        ["Protocol", String(status.protocolVersion)],
        ["Schema", String(status.schemaVersion)],
        ["Uptime", formatDuration(Date.now() - status.uptimeMs, Date.now())],
      ],
    ],
    [
      "Storage",
      [
        ["Database", formatBytes(status.sizes.database)],
        ["WAL", formatBytes(status.sizes.wal)],
        ["SHM", formatBytes(status.sizes.shm)],
        ["Database cap", formatBytes(status.policy.maxDatabaseBytes)],
        ["Spool cap", formatBytes(status.policy.maxSpoolBytes)],
      ],
    ],
    [
      "Retained projections",
      [
        ["Events", String(status.eventCount)],
        ["Runs", String(status.runCount)],
        ["Agents", String(status.agentCount)],
        ["Current sequence", String(status.currentSeq)],
        ["Retained floor", String(status.minRetainedSeq)],
      ],
    ],
    [
      "Ingest counters",
      Object.entries(status.counters).map(([key, value]) => [
        key,
        String(value),
      ]),
    ],
    ["Redaction classes", countEntries(status.redactionByClass)],
    ["Rejected reasons", countEntries(status.rejectedByReason)],
  ];
  for (const [title, entries] of cards) {
    const card = element(document, "section", "health-card");
    card.append(element(document, "h3", "", title));
    card.append(metricList(entries));
    grid.append(card);
  }
  section.append(grid);

  const policy = element(document, "section", "health-card");
  policy.append(element(document, "h3", "", "Project policy"));
  if (status.policy.projects.length === 0) {
    policy.append(
      element(
        document,
        "p",
        "empty-note",
        `No project overrides. Default content mode: ${status.policy.defaultContentMode}.`,
      ),
    );
  } else {
    policy.append(
      metricList(
        status.policy.projects.map((project) => [
          project.root,
          `${project.enabled ? "enabled" : "disabled"} · ${project.contentMode}`,
        ]),
      ),
    );
  }
  section.append(policy);
  replaceApp(section);
}

function handleViewError(error, retry) {
  if (error instanceof ApiFailure && error.status === 401) {
    setConnection("Read capability rejected", "error");
    renderFatal(
      "Read capability required",
      "The capability is missing, invalid, or expired. Run /observability again.",
    );
    return;
  }
  const section = statePanel(
    "Unable to load this view",
    error instanceof ApiFailure
      ? `The daemon rejected the read (${error.code}). No captured content was shown.`
      : "The local daemon could not be reached. Orchestration is unaffected.",
    "error",
  );
  const actions = element(document, "div", "actions");
  const button = element(document, "button", "", "Retry view");
  button.type = "button";
  button.addEventListener("click", () => void retry());
  actions.append(button);
  section.append(actions);
  replaceApp(section);
  setConnection("Read error", "error");
}

export function main() {
  readCapability = consumeBootstrapToken(window.location, window.history);
  appRoot = document.querySelector("#app");
  connectionState = document.querySelector("#connection-state");
  for (const button of document.querySelectorAll("[data-view]")) {
    button.addEventListener("click", () => {
      if (!readCapability) {
        renderFatal(
          "Read capability required",
          "Open this page with the trusted /observability command. No data request was made.",
        );
        return;
      }
      if (button.dataset.view === "health") void showHealth();
      else void showRuns();
    });
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && activeView.timer === undefined && readCapability)
      reloadCurrentView();
  });
  window.addEventListener("hashchange", () => {
    const next = consumeBootstrapToken(window.location, window.history);
    if (!next) return;
    readCapability = next;
    void showRuns();
  });
  if (!readCapability) {
    setConnection("Read capability required", "error");
    renderFatal(
      "Read capability required",
      "Open this page with the trusted /observability command. The static shell contains no captured data.",
    );
    return;
  }
  void showRuns();
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  main();
}
