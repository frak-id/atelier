# Agent scripts

Shell the agent runs for toolset build/capture/materialize. Each file is
embedded into the binary with `include_str!` (`src/toolset.rs`) and run as
`bash -c <script> bash <args...>`, so inputs arrive as positional arguments
(user-controlled values: paths, globs, references) or environment variables
(fixed paths and format settings the agent owns). Nothing is interpolated
into a script body.

Lint: `shellcheck -s bash apps/agent/scripts/*.sh`.
