(function () {
  "use strict";
  const form = document.getElementById("wallet-form");
  const input = document.getElementById("wallet");
  const error = document.getElementById("form-error");
  const reportRoot = document.getElementById("report");
  const demoButton = document.getElementById("demo-button");
  let currentReport = null;
  let lastRequest = null;
  let activeController = null;
  let requestSequence = 0;

  const el = (tag, options = {}) => {
    const node = document.createElement(tag);
    if (options.className) node.className = options.className;
    if (options.text !== undefined) node.textContent = String(options.text);
    if (options.attrs) Object.entries(options.attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
    return node;
  };
  const append = (node, ...children) => { children.flat().filter(Boolean).forEach(child => node.append(child)); return node; };
  const isAddress = value => /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/i.test(value);
  const unknown = text => el("span", { className: "unknown", text: text || "unknown" });
  const statusClass = status => /FAILED/.test(status || "") ? "failed" : /PARTIAL|UNSUPPORTED/.test(status || "") ? "partial" : "";
  const humanStatus = status => ({ VERIFIED_POINT_IN_TIME: "Observed", VERIFIED_BOUNDED_SCOPE: "Observed", COMPLETE: "Complete", PARTIAL_POINT_IN_TIME: "Partial", PARTIAL_BOUNDED_SCOPE: "Partial", PARTIAL: "Partial", READ_FAILED: "Unavailable", UNSUPPORTED_MANAGED: "Managed · not covered" })[status] || "Unknown";
  const shorten = value => typeof value === "string" && value.length > 18 ? `${value.slice(0, 9)}…${value.slice(-7)}` : value;
  const date = value => { try { return value ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "unknown"; } catch { return "unknown"; } };
  const amount = row => row && row.amountFormatted !== null && row.amountFormatted !== undefined ? row.amountFormatted : null;
  const lockAmount = row => row && row.principalFormatted !== null && row.principalFormatted !== undefined ? row.principalFormatted : null;
  const trustedAmount = row => row && ["ONCHAIN", "CANONICAL"].includes(row.decimalsSource) ? amount(row) : null;
  const basescanAddress = address => typeof address === "string" && /^0x[0-9a-fA-F]{40}$/.test(address) ? `https://basescan.org/address/${address}` : null;
  const format18 = raw => { try { const value = BigInt(raw); const scale = 1000000000000000000n; const whole = value / scale; const fraction = (value % scale).toString().padStart(18, "0").replace(/0+$/, ""); return fraction ? `${whole}.${fraction}` : whole.toString(); } catch { return null; } };

  function setError(message) {
    error.hidden = !message;
    error.textContent = message || "";
    input.setAttribute("aria-invalid", message ? "true" : "false");
  }
  function clearRoot() { reportRoot.replaceChildren(); }
  function showLoading(label) {
    clearRoot(); reportRoot.setAttribute("aria-busy", "true");
    append(reportRoot, append(el("div", { className: "loading" }), el("span", { className: "loading-dot", attrs: { "aria-hidden": "true" } }), el("span", { text: label })));
  }
  function section(title, note) {
    const node = el("section", { className: "section" });
    const heading = el("h2", { className: "section-title", text: title });
    if (note) heading.append(el("small", { text: note }));
    node.append(heading); return node;
  }
  function createTable(headers, rows) {
    const table = el("table", { className: "data-table" });
    const thead = el("thead"), head = el("tr");
    headers.forEach(header => head.append(el("th", { text: header, attrs: { scope: "col" } }))); thead.append(head);
    const tbody = el("tbody"); rows.forEach(cells => { const tr = el("tr"); cells.forEach((cell, index) => {
      const td = el("td", { className: cell && cell.className || "", attrs: { "data-label": headers[index] || "" } });
      if (cell && cell.node) td.append(cell.node); else td.append(cell === null || cell === undefined ? unknown() : document.createTextNode(String(cell)));
      tr.append(td);
    }); tbody.append(tr); }); table.append(thead, tbody); return append(el("div", { className: "table-wrap" }), table);
  }
  function source(url, synthetic) { if (synthetic) return el("span", { className: "state", text: "Fixture data" }); return typeof url === "string" && /^https:\/\/basescan\.org\//.test(url) ? el("a", { className: "source-link", text: "Source ↗", attrs: { href: url, target: "_blank", rel: "noopener noreferrer" } }) : unknown("source unavailable"); }
  function addDisclosure(parent, label, lines) { if (!Array.isArray(lines) || !lines.length) return; const details = el("details", { className: "disclosure" }); details.append(el("summary", { text: label })); const list = el("ul"); lines.forEach(line => list.append(el("li", { text: line }))); details.append(list); parent.append(details); }

  function renderReport(payload) {
    const report = payload.report;
    currentReport = payload;
    reportRoot.setAttribute("aria-busy", "false"); clearRoot();
    const head = el("header", { className: "report-head" });
    const title = append(el("div"), el("p", { className: "report-kicker", text: "Address snapshot" }), el("p", { className: "wallet-address", text: report.wallet || "Address unknown" }));
    const actions = el("div", { className: "report-actions" });
    const synthetic = payload.source === "SYNTHETIC";
    actions.append(el("span", { className: `badge ${synthetic ? "synthetic" : "live"}`, text: synthetic ? "Synthetic demo · fixture balances & times" : "Live RPC" }));
    const download = el("button", { className: "download", text: "View JSON", attrs: { type: "button", title: "View the exact report as JSON", "aria-expanded": "false" } });
    download.addEventListener("click", () => showReportJson(download)); actions.append(download); head.append(title, actions); reportRoot.append(head);

    const obs = report.observation || {};
    reportRoot.append(append(el("div", { className: "provenance" }), el("span", { text: `Block: ${obs.blockNumber || "unknown"}` }), el("span", { text: `Block time: ${date(obs.blockTimestamp)}` }), el("span", { text: `Observed: ${date(obs.observedAt)}` }), el("span", { text: `Network: Base / ${report.chainId || 8453}` })));
    reportRoot.append(append(el("div", { className: "summary" }), el("p", { text: `Snapshot at block ${obs.blockNumber || "unknown"}. Liquid funds, locks, voting power and rewards are shown separately.` })));
    const partial = report.status === "PARTIAL_BOUNDED_SCOPE";
    reportRoot.append(el("p", { className: `status-note ${partial ? "partial" : ""}`, text: partial ? "Some data is unavailable or outside the checked scope. This does not mean a zero balance." : "A bounded Base snapshot at one point in time. Sections are not combined into a total value." }));

    const balances = section("Liquid balances", "no USD valuation");
    const balanceRows = (report.liquidBalances || []).map(row => [
      { node: append(el("span", { text: row.symbol || "unknown token" }), row.token ? el("div", { className: "mono", text: shorten(row.token) }) : null) },
      { className: "numeric", node: amount(row) === null ? unknown(row.amountRaw ? `${row.amountRaw} raw; decimals unknown` : "data unavailable") : el("span", { text: amount(row) }) },
      { node: el("span", { className: `state ${statusClass(row.status)}`, text: humanStatus(row.status) }) },
      { node: source(row.source, synthetic) }
    ]);
    balances.append(createTable(["Asset", "Amount", "Status", ""], balanceRows.length ? balanceRows : [[{ node: unknown("balances were not returned") }, "", "", ""]])); addDisclosure(balances, "Coverage limits", [report.coverage && report.coverage.balances, report.coverage && report.coverage.totals].filter(Boolean)); reportRoot.append(balances);

    const positions = section("veNFT locks", `checked up to ${report.discovery && report.discovery.limit || 16}`);
    const lockTokenLabel = row => {
      const known = (report.liquidBalances || []).find(balance => balance.token && row.token && balance.token.toLowerCase() === row.token.toLowerCase());
      return known ? `${known.symbol} · ${shorten(row.token)}` : row.token ? shorten(row.token) : "token unknown";
    };
    const lockRows = (report.locks || []).map(row => [
      { node: el("span", { text: `#${row.tokenId}` }) },
      { className: "numeric", node: append(lockAmount(row) === null ? unknown(row.principalRaw ? `${row.principalRaw} raw; units unknown` : "personal principal unknown") : el("span", { text: lockAmount(row) }), el("div", { className: "mono", text: lockTokenLabel(row) })) },
      { node: row.permanent ? el("span", { text: "permanent" }) : row.unlockAt ? el("span", { text: date(row.unlockAt) }) : unknown("unknown") },
      { node: el("span", { className: `state ${statusClass(row.status)}`, text: humanStatus(row.status) }) },
      { node: source(row.source, synthetic) }
    ]);
    const noLocks = report.discovery && report.discovery.status === "COMPLETE" && report.discovery.ownedCount === "0" ? "No veNFTs found." : "veNFT positions were not found or remain unknown.";
    positions.append(createTable(["veNFT", "Principal", "Unlock", "Status", ""], lockRows.length ? lockRows : [[{ node: unknown(noLocks) }, "", "", "", ""]]));
    addDisclosure(positions, "Coverage limits", [report.coverage && report.coverage.positions, report.discovery && `Discovered ${report.discovery.tokenIds ? report.discovery.tokenIds.length : 0} of ${report.discovery.ownedCount === null ? "an unknown total" : report.discovery.ownedCount}; ${humanStatus(report.discovery.status)}.`].filter(Boolean)); reportRoot.append(positions);

    const voting = section("Voting", "current epoch");
    const vote = report.voting;
    if (!vote) voting.append(el("p", { className: "status-note partial", text: "Voting data is unknown. No entries do not establish that voting power is absent." }));
    else {
      const rows = (vote.positions || []).map(row => [{ node: el("span", { text: `#${row.tokenId}` }) }, { className: "numeric", node: format18(row.currentVotingPowerRaw) === null ? unknown("unavailable") : el("span", { text: format18(row.currentVotingPowerRaw) }) }, { node: el("span", { text: row.votedThisEpoch ? "vote recorded" : "no vote recorded" }) }, { node: row.lastVotedAt ? el("span", { text: date(row.lastVotedAt) }) : unknown("no timestamp") }]);
      voting.append(createTable(["veNFT", "Voting power", "This epoch", "Last vote"], rows.length ? rows : [[{ node: unknown("no positions in the available snapshot") }, "", "", ""]]));
      addDisclosure(voting, "Coverage limits", [vote.coverage && vote.coverage.scope, vote.coverage && vote.coverage.profitability, report.coverage && report.coverage.voting].filter(Boolean));
    } reportRoot.append(voting);

    const rewards = section("Claimable rewards", "bounded check");
    const reward = report.rewards;
    if (!reward) rewards.append(el("p", { className: "status-note partial", text: "Rewards are unknown. This does not mean no rewards are available." }));
    else {
      const rows = [...(reward.votingRewards || []), ...(reward.gaugeRewards || [])].map(row => [
        { node: append(el("span", { text: row.symbol || "token unknown" }), el("div", { className: "mono", text: shorten(row.token) })) },
        { className: "numeric", node: trustedAmount(row) === null ? unknown(`${row.amountRaw || "?"} raw; decimals unknown`) : el("span", { text: trustedAmount(row) }) },
        { node: el("span", { text: "tokenId" in row ? (row.type === "bribe" ? "bribe" : "fee") : "gauge" }) },
        { node: source(basescanAddress("rewardContract" in row ? row.rewardContract : row.gauge), synthetic) }
      ]);
      const rewardEmpty = reward.status === "PARTIAL_BOUNDED_SCOPE" ? "Rewards in the incomplete scope are unknown; no rows do not mean zero." : "No non-zero rewards were found in the checked scope.";
      rewards.append(createTable(["Token", "Amount", "Type", ""], rows.length ? rows : [[{ node: unknown(rewardEmpty) }, "", "", ""]]));
      addDisclosure(rewards, "Coverage limits", [reward.coverage && reward.coverage.scope, reward.coverage && reward.coverage.historicalUnclaimedPools, reward.coverage && reward.coverage.realizableValue, report.coverage && report.coverage.rewards].filter(Boolean));
    } reportRoot.append(rewards);

    const protocol = section("Protocol context", "point in time");
    const epoch = report.protocol && report.protocol.epoch;
    const grid = el("div", { className: "card-grid" });
    [["Voting window", epoch ? (epoch.normalVotingOpen ? "open" : "closed") : "unknown"], ["Epoch ends", epoch ? date(epoch.next) : "unknown"], ["Pools", report.protocol && report.protocol.protocol ? report.protocol.protocol.poolCount : "unknown"], ["Max pools per vote", report.protocol && report.protocol.protocol ? report.protocol.protocol.maxPoolsPerVote : "unknown"]].forEach(([label, value]) => grid.append(append(el("article", { className: "metric-card" }), el("h3", { text: label }), el("p", { text: value })))); protocol.append(grid); addDisclosure(protocol, "Outside this report", [report.coverage && report.coverage.consistency, report.protocol && report.protocol.coverage && report.protocol.coverage.pricing, report.protocol && report.protocol.coverage && report.protocol.coverage.transactions].filter(Boolean)); reportRoot.append(protocol);
    addDisclosure(reportRoot, "Warnings and unknowns", (report.warnings || []).length ? report.warnings : ["No explicit warnings were returned for this snapshot. Coverage limits still apply."]);
    reportRoot.focus({ preventScroll: true });
  }
  function showReportJson(button) {
    if (!currentReport) return;
    const existing = document.getElementById("report-json");
    if (existing) { existing.remove(); button.setAttribute("aria-expanded", "false"); return; }
    const box = el("section", { attrs: { id: "report-json", "aria-label": "Exact JSON report" }, className: "json-report" });
    box.append(el("label", { text: "Exact report · JSON", attrs: { for: "report-json-text" } }));
    const field = el("textarea", { attrs: { id: "report-json-text", readonly: "", rows: "12", spellcheck: "false" } });
    field.value = JSON.stringify(currentReport, null, 2);
    box.append(field); button.closest(".report-head").after(box);
    button.setAttribute("aria-expanded", "true"); field.focus(); field.select();
  }
  function renderError(message) { reportRoot.setAttribute("aria-busy", "false"); clearRoot(); const state = el("section", { className: "error-state" }); state.append(el("h2", { text: "Snapshot unavailable" }), el("p", { text: message })); const retry = el("button", { className: "retry", text: "Try again", attrs: { type: "button" } }); retry.addEventListener("click", () => lastRequest && load(lastRequest)); state.append(retry); reportRoot.append(state); reportRoot.focus({ preventScroll: true }); }
  async function load(request) {
    lastRequest = request;
    if (activeController) activeController.abort();
    activeController = new AbortController();
    const controller = activeController;
    const sequence = ++requestSequence;
    setError(""); showLoading(request.type === "demo" ? "Opening synthetic demo snapshot…" : "Requesting Base snapshot…");
    try {
      const response = await fetch(request.type === "demo" ? "/api/demo" : "/api/overview", request.type === "demo" ? { headers: { Accept: "application/json" }, signal: controller.signal } : { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ wallet: request.wallet }), signal: controller.signal });
      let body = null; try { body = await response.json(); } catch { /* handled below */ }
      if (sequence !== requestSequence) return;
      if (!response.ok || !body || !body.report) { const apiMessage = body && body.error && body.error.message; throw new Error(apiMessage || (response.status === 429 ? "Too many requests. Wait a moment and try again." : response.status >= 500 ? "The data provider is temporarily unavailable. Try again." : "The server did not return an expected report.")); }
      renderReport(body);
    } catch (err) {
      if (sequence !== requestSequence || (err && err.name === "AbortError")) return;
      renderError(err instanceof Error ? err.message : "The report could not be retrieved. Try again.");
    } finally { if (sequence === requestSequence && activeController === controller) activeController = null; }
  }
  form.addEventListener("submit", event => { event.preventDefault(); const wallet = input.value.trim(); if (!isAddress(wallet)) { setError("Enter a valid non-zero address: 0x followed by 40 hexadecimal characters."); input.focus(); return; } load({ type: "live", wallet }); });
  demoButton.addEventListener("click", () => load({ type: "demo" }));
}());
