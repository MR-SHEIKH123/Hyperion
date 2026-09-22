-- 025 — which tools may use which plugin.
--
-- Everything else about a plugin is already stored by the module that owns it:
-- `mcp_servers.enabled`, `skills.enabled`, the memory plugin's own switch. What
-- did not exist anywhere is the one fact the Plugins hub is for: *who may use
-- this*. This table records only the deviations from the default, and the
-- default is "every tool may use it".
--
-- Three decisions, each of which could reasonably have gone the other way:
--
--   1. **Absence is not "off".** No row for (plugin, tool) means available. A hub
--      that defaulted to unavailable would silently change what every existing
--      install can do the moment it shipped, and the user would have no way to
--      tell which of their tools had gone quiet.
--   2. **No foreign key, and the id is opaque.** A plugin id is composite —
--      `mcp:<server id>`, `skill:<skill id>`, `builtin:memory` — and its parts
--      live in two tables and a directory, so one FK is not expressible and a
--      column per kind would leave three orphan columns behind. Ids are
--      validated by the hub, which knows what exists; a row whose subject is
--      gone is reported as debris (`orphanedAvailability`) and pruned by the
--      next availability write rather than deleted by a reader.
--   3. **No CHECK on `tool`.** A closed vocabulary here would mean adding a tool
--      requires a table rebuild, which is exactly the operation that has lost
--      columns in this schema before (see `023`). The tool is validated in code
--      against `TOOLS`, where adding a tool is a one-line change.
CREATE TABLE plugin_availability (
  plugin_id  TEXT NOT NULL,
  tool       TEXT NOT NULL,
  available  INTEGER NOT NULL CHECK (available IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, tool)
);
