using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [(name = "internet", network = (allow = [], tlsOptions = (trustBrowserCas = false))),
    (name = "probe", worker = (
    compatibilityDate = "2026-11-23",
    modules = [(name = "worker.mjs", esModule = embed "worker.mjs"),
               (name = "session.mjs", esModule = embed "session.mjs")],
    bindings = [
      (name = "PROBE_SESSION", durableObjectNamespace = "ProbeSession"),
      (name = "PROBE_BROWSER_GRANT", fromEnvironment = "PROBE_BROWSER_GRANT"),
      (name = "PROBE_AGENT_GRANT", fromEnvironment = "PROBE_AGENT_GRANT"),
      (name = "PROBE_LIFETIME_MS", fromEnvironment = "PROBE_LIFETIME_MS"),
      (name = "PROBE_BROWSER_ORIGIN", fromEnvironment = "PROBE_BROWSER_ORIGIN")
    ],
    durableObjectNamespaces = [(className = "ProbeSession",
        uniqueKey = "bf7245db058e471ab6845f889f846a26", preventEviction = true)],
    durableObjectStorage = (inMemory = void)
  ))],
  sockets = [(name = "http", address = "127.0.0.1:0", http = (), service = "probe")]
);
