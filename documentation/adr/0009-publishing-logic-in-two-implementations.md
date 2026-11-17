# The publishing logic exists two times, in the plugin and in a Rust command line program, under a parity rule

The publishing tool has four faces: an Obsidian plugin (from the author's plugin template), a command line program, an MCP server and a skill, so that the author and an AI can both drive a publication. The logic behind them (find what changed, run the privacy gate, clean the notes, write the content store, correct the `public_note` property) is written two times: in TypeScript inside the plugin, and in Rust inside the command line program, which runs on Linux and Windows with Obsidian closed. A parity rule binds them: for the same vault, both give the same publication plan, the same cleaned notes and the same manifest. The Obsidian Starter Kit plugin of the author works this way, with its own Rust command line program.

Considered: Rust only, with the plugin as a view that calls the program. The assistant recommended it, because every rule then exists one time. The author chose the pattern that he already runs. Also considered: TypeScript only, with a thin command line program that needs a running Obsidian.

Consequence: every rule is written and tested two times. Parity tests on the fixture vault block a release. What the MCP server can do, the command line program can do, and the reverse. This changes decision D17 ("one publish core with two hosts").
