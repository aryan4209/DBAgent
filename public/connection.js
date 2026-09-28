"use strict";

// Connection dialog: edit SQL Server connection properties, preview the
// connection string, test, and save to .env. Uses api() and loadStatus() from app.js.
(() => {
  const q = (id) => document.getElementById(id);
  const d = {
    dialog: q("connDialog"), form: q("connForm"),
    server: q("f-server"), port: q("f-port"), user: q("f-user"), password: q("f-password"),
    database: q("f-database"), dbList: q("dbList"),
    encrypt: q("f-encrypt"), trust: q("f-trust"), readonly: q("f-readonly"),
    timeout: q("f-timeout"), maxrows: q("f-maxrows"),
    connString: q("connString"), reveal: q("revealInString"), copy: q("copyConnString"),
    togglePassword: q("togglePassword"), loadDatabases: q("loadDatabases"),
    pasteInput: q("pasteInput"), pasteApply: q("pasteApply"),
    result: q("testResult"), test: q("testConnection"), save: q("saveConnection"),
    cancel: q("connCancel"), close: q("connClose"),
  };

  let format = "adonet";
  let hasSavedPassword = false;
  let busy = false;

  // ---------- Form values ----------

  function values() {
    return {
      server: d.server.value.trim(),
      port: Number(d.port.value) || 1433,
      database: d.database.value.trim(),
      user: d.user.value.trim(),
      password: d.password.value,
      encrypt: d.encrypt.checked,
      trustServerCertificate: d.trust.checked,
      readOnlyIntent: d.readonly.checked,
      requestTimeoutMs: Number(d.timeout.value) || 30000,
      maxRows: Number(d.maxrows.value) || 200,
    };
  }

  function fill(c) {
    d.server.value = c.server ?? "";
    d.port.value = c.port ?? 1433;
    d.database.value = c.database ?? "";
    d.user.value = c.user ?? "";
    d.encrypt.checked = Boolean(c.encrypt);
    d.trust.checked = Boolean(c.trustServerCertificate);
    d.readonly.checked = Boolean(c.readOnlyIntent);
    d.timeout.value = c.requestTimeoutMs ?? 30000;
    d.maxrows.value = c.maxRows ?? 200;
  }

  // ---------- Connection string ----------

  const quoteAdo = (v) => (/[;"']|^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const quoteBraces = (v) => (/[;{}=\s]/.test(v) ? `{${v.replace(/}/g, "}}")}}` : v);

  /** Returns { prefix, parts: [{ key, value, secret }] } for the chosen format. */
  function buildParts(v, fmt, passwordText) {
    const [host, instance] = v.server.split("\\");
    const defaultPort = v.port === 1433;
    const tf = (b, yes = "True", no = "False") => (b ? yes : no);
    const parts = [];
    const add = (key, value, secret = false) => {
      if (value !== "" && value !== undefined) parts.push({ key, value, secret });
    };

    if (fmt === "adonet") {
      add("Server", instance ? `${host}\\${instance}${defaultPort ? "" : "," + v.port}` : `${host || "localhost"},${v.port}`);
      add("Database", v.database);
      add("User ID", v.user);
      add("Password", passwordText, true);
      add("Encrypt", tf(v.encrypt));
      add("TrustServerCertificate", tf(v.trustServerCertificate));
      if (v.readOnlyIntent) add("ApplicationIntent", "ReadOnly");
      add("Command Timeout", String(Math.round(v.requestTimeoutMs / 1000)));
      add("Application Name", "db-agent");
      return { prefix: "", parts, quote: quoteAdo };
    }

    if (fmt === "odbc") {
      parts.push({ key: "Driver", value: "{ODBC Driver 18 for SQL Server}", raw: true });
      add("Server", instance ? `${host}\\${instance}` : `tcp:${host || "localhost"},${v.port}`);
      add("Database", v.database);
      add("Uid", v.user);
      add("Pwd", passwordText, true);
      add("Encrypt", tf(v.encrypt, "yes", "no"));
      add("TrustServerCertificate", tf(v.trustServerCertificate, "yes", "no"));
      if (v.readOnlyIntent) add("ApplicationIntent", "ReadOnly");
      add("APP", "db-agent");
      return { prefix: "", parts, quote: quoteBraces };
    }

    // JDBC
    const prefix = `jdbc:sqlserver://${host || "localhost"}${instance ? "\\" + instance : ""}${instance && defaultPort ? "" : ":" + v.port}`;
    add("databaseName", v.database);
    add("user", v.user);
    add("password", passwordText, true);
    add("encrypt", tf(v.encrypt, "true", "false"));
    add("trustServerCertificate", tf(v.trustServerCertificate, "true", "false"));
    if (v.readOnlyIntent) add("applicationIntent", "ReadOnly");
    add("applicationName", "db-agent");
    return { prefix, parts, quote: quoteBraces };
  }

  function passwordText() {
    if (d.password.value) return d.reveal.checked ? d.password.value : "********";
    return hasSavedPassword ? "<saved password>" : "";
  }

  function renderConnString() {
    const { prefix, parts, quote } = buildParts(values(), format, passwordText());
    const box = d.connString;
    box.replaceChildren();
    const text = [];

    if (prefix) {
      box.append(prefix);
      text.push(prefix);
    }
    parts.forEach((p, i) => {
      const value = p.raw || (p.secret && !d.reveal.checked) ? p.value : quote(p.value);
      if (i > 0 || prefix) box.append(";");
      const k = document.createElement("span");
      k.className = "k";
      k.textContent = `${p.key}=`;
      box.append(k);
      if (p.secret) {
        const s = document.createElement("span");
        s.className = "pw";
        s.textContent = value;
        box.append(s);
      } else {
        box.append(value);
      }
      text.push(`${p.key}=${value}`);
    });
    box.dataset.text = prefix ? `${prefix};${text.slice(1).join(";")}` : text.join(";");
    d.reveal.disabled = !d.password.value;
  }

  // ---------- Parsing a pasted connection string ----------

  /** Splits "k=v;k2={v;2};k3="v""3"" into [key, value] pairs. */
  function tokenize(str) {
    const pairs = [];
    let i = 0;
    while (i < str.length) {
      while (i < str.length && /[\s;]/.test(str[i])) i++;
      const eq = str.indexOf("=", i);
      if (eq < 0) break;
      const key = str.slice(i, eq).trim();
      i = eq + 1;
      while (str[i] === " ") i++;
      let value = "";
      const open = str[i];
      if (open === "{" || open === '"' || open === "'") {
        const close = open === "{" ? "}" : open;
        i++;
        while (i < str.length) {
          if (str[i] === close) {
            if (str[i + 1] === close) { value += close; i += 2; continue; }
            i++;
            break;
          }
          value += str[i++];
        }
        while (i < str.length && str[i] !== ";") i++;
      } else {
        const end = str.indexOf(";", i);
        value = (end < 0 ? str.slice(i) : str.slice(i, end)).trim();
        i = end < 0 ? str.length : end;
      }
      if (key) pairs.push([key, value]);
    }
    return pairs;
  }

  function parseConnString(str) {
    const out = {};
    const warnings = [];
    let rest = str.trim();
    const truthy = (v) => /^(true|yes|mandatory|strict|1)$/i.test(v);
    const setServer = (v) => {
      v = v.replace(/^tcp:/i, "");
      const [host, port] = v.split(",");
      out.server = host.trim();
      if (port) out.port = Number(port.trim());
    };

    const jdbc = rest.match(/^jdbc:sqlserver:\/\/([^;]*)/i);
    if (jdbc) {
      const m = jdbc[1].match(/^([^\\:]*)(?:\\([^:]+))?(?::(\d+))?$/);
      if (m) {
        if (m[1]) out.server = m[1] + (m[2] ? "\\" + m[2] : "");
        if (m[3]) out.port = Number(m[3]);
      }
      rest = rest.slice(jdbc[0].length);
    }

    for (const [rawKey, value] of tokenize(rest)) {
      const key = rawKey.toLowerCase().replace(/[\s_]/g, "");
      if (["server", "datasource", "address", "addr", "networkaddress", "servername"].includes(key)) setServer(value);
      else if (["port", "portnumber"].includes(key)) out.port = Number(value);
      else if (key === "instancename") out.server = `${out.server || "localhost"}\\${value}`;
      else if (["database", "initialcatalog", "databasename"].includes(key)) out.database = value;
      else if (["userid", "uid", "user", "username"].includes(key)) out.user = value;
      else if (["password", "pwd"].includes(key)) out.password = value;
      else if (key === "encrypt") out.encrypt = truthy(value);
      else if (key === "trustservercertificate") out.trustServerCertificate = truthy(value);
      else if (key === "applicationintent") out.readOnlyIntent = /readonly/i.test(value);
      else if (["integratedsecurity", "trustedconnection"].includes(key) && /^(true|yes|sspi)$/i.test(value)) {
        warnings.push("Windows (integrated) authentication isn't supported; enter a SQL login and password.");
      }
    }
    return { out, warnings };
  }

  function applyPaste() {
    const { out, warnings } = parseConnString(d.pasteInput.value);
    const count = Object.keys(out).length;
    if (!count) {
      showResult("bad", "Couldn't find any connection properties in that text.");
      return;
    }
    if (out.server !== undefined) d.server.value = out.server;
    if (out.port) d.port.value = out.port;
    if (out.database !== undefined) d.database.value = out.database;
    if (out.user !== undefined) d.user.value = out.user;
    if (out.password !== undefined) d.password.value = out.password;
    if (out.encrypt !== undefined) d.encrypt.checked = out.encrypt;
    if (out.trustServerCertificate !== undefined) d.trust.checked = out.trustServerCertificate;
    if (out.readOnlyIntent !== undefined) d.readonly.checked = out.readOnlyIntent;
    d.pasteInput.value = "";
    d.pasteInput.closest("details").open = false;
    renderConnString();
    showResult(warnings.length ? "bad" : "ok", `Filled ${count} field${count === 1 ? "" : "s"} from the connection string.`, warnings);
  }

  // ---------- Test / save ----------

  function showResult(kind, title, lines = []) {
    d.result.hidden = false;
    d.result.className = `test-result ${kind}`;
    d.result.replaceChildren();
    const b = document.createElement("b");
    b.textContent = title;
    d.result.append(b);
    for (const line of lines) {
      const div = document.createElement("div");
      if (typeof line === "object") {
        div.className = line.className;
        div.textContent = line.text;
      } else {
        div.textContent = line;
      }
      d.result.append(div);
    }
  }

  function validate({ forSave }) {
    const v = values();
    const missing = [];
    const mark = (input, bad, name) => {
      input.classList.toggle("invalid", bad);
      if (bad) missing.push(name);
    };
    mark(d.server, !v.server, "server");
    mark(d.user, !v.user, "login");
    mark(d.password, !v.password && !hasSavedPassword, "password");
    mark(d.database, forSave && !v.database, "database");
    if (missing.length) {
      showResult("bad", `Please fill in: ${missing.join(", ")}.`);
      return false;
    }
    return true;
  }

  function setBusy(on, label) {
    busy = on;
    for (const b of [d.test, d.save, d.loadDatabases]) b.disabled = on;
    if (on) showResult("busy", label);
  }

  async function testConnection() {
    if (busy || !validate({ forSave: false })) return;
    setBusy(true, "Testing connection…");
    try {
      const r = await api("/api/connection/test", { method: "POST", body: JSON.stringify(values()) });
      if (!r.ok) return showResult("bad", "Connection failed", [r.error]);

      d.dbList.replaceChildren(...r.databases.map((name) => Object.assign(document.createElement("option"), { value: name })));
      const lines = [r.description, `Signed in as ${r.login} · default database ${r.database}`];
      lines.push(r.databases.length
        ? `${r.databases.length} database${r.databases.length === 1 ? "" : "s"} available: pick one in the Database box.`
        : "No user databases are accessible to this login.");
      if (r.writeCapabilities.length) {
        lines.push({ className: "warn", text: `This login has write-capable roles (${r.writeCapabilities.join(", ")}). The agent still blocks writes, but a db_datareader-only login is safer.` });
      }
      showResult("ok", "Connection succeeded", lines);
      if (!d.database.value && r.databases.length) {
        d.database.focus();
        d.database.showPicker?.();
      }
    } catch (err) {
      showResult("bad", "Connection test failed", [err.message]);
    } finally {
      setBusy(false);
    }
  }

  async function save(e) {
    e.preventDefault();
    if (busy || !validate({ forSave: true })) return;
    setBusy(true, "Connecting and saving…");
    try {
      const r = await api("/api/connection", { method: "PUT", body: JSON.stringify(values()) });
      if (!r.ok) return showResult("bad", "Not saved: connection failed", [r.error]);
      d.dialog.close();
      loadStatus();
    } catch (err) {
      showResult("bad", "Not saved", [err.message]);
    } finally {
      setBusy(false);
    }
  }

  // ---------- Open / close ----------

  async function open() {
    let current;
    try {
      current = await api("/api/connection");
    } catch (err) {
      alert(`Couldn't load connection settings: ${err.message}`);
      return;
    }
    fill(current);
    hasSavedPassword = current.hasPassword;
    d.password.value = "";
    d.password.type = "password";
    d.togglePassword.textContent = "Show";
    d.password.placeholder = hasSavedPassword ? "Saved (leave blank to keep)" : "";
    d.reveal.checked = false;
    d.result.hidden = true;
    d.save.title = current.canSave ? "" : "Saving is disabled on this server";
    for (const input of d.form.querySelectorAll(".invalid")) input.classList.remove("invalid");
    renderConnString();
    d.dialog.showModal();
    const firstEmpty = [d.server, d.user, d.password, d.database].find((i) => !i.value && !(i === d.password && hasSavedPassword));
    (firstEmpty ?? d.server).focus();
  }

  // ---------- Events ----------

  d.form.addEventListener("input", (e) => {
    e.target.classList?.remove("invalid");
    renderConnString();
  });
  d.form.addEventListener("change", renderConnString);
  d.form.addEventListener("submit", save);
  d.test.addEventListener("click", testConnection);
  d.loadDatabases.addEventListener("click", testConnection);
  d.pasteApply.addEventListener("click", applyPaste);
  d.cancel.addEventListener("click", () => d.dialog.close());
  d.close.addEventListener("click", () => d.dialog.close());

  d.togglePassword.addEventListener("click", () => {
    const show = d.password.type === "password";
    d.password.type = show ? "text" : "password";
    d.togglePassword.textContent = show ? "Hide" : "Show";
    d.togglePassword.setAttribute("aria-label", show ? "Hide password" : "Show password");
  });

  for (const btn of document.querySelectorAll(".seg button")) {
    btn.addEventListener("click", () => {
      format = btn.dataset.format;
      for (const b of document.querySelectorAll(".seg button")) {
        b.classList.toggle("active", b === btn);
        b.setAttribute("aria-selected", String(b === btn));
      }
      renderConnString();
    });
  }

  d.copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(d.connString.dataset.text || "");
      d.copy.textContent = d.password.value && !d.reveal.checked ? "Copied (password hidden)" : "Copied";
    } catch {
      d.copy.textContent = "Copy failed";
    }
    setTimeout(() => (d.copy.textContent = "Copy"), 1800);
  });

  q("openConnection").addEventListener("click", open);
  window.openConnectionDialog = open;

  // First run: open the dialog straight away if nothing is configured yet.
  api("/api/status")
    .then((s) => {
      if (!s.connected && /Missing settings/.test(s.error || "")) open();
    })
    .catch(() => {});
})();
