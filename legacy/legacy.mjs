#!/usr/bin/env node
// LEGACY01 - the stand-in legacy account-and-ledger report program (the parity oracle).
// Plain procedural JavaScript, Node built-ins only, nothing imported from outside legacy/.
//
// Exit codes:
//   0  report printed (an INQUIRY for an unknown account prints an NFD line and still exits 0)
//   1  unexpected internal error
//   2  usage / argument error (message on stderr, nothing on stdout)
//   3  data file missing or unreadable
//   4  POST refused (unknown account, non-numeric or overflowing balance)

import process from "node:process";
import { parseArgs, runTimestamp, UsageError, USAGE } from "./lib/args.mjs";
import { DataFileError } from "./lib/files.mjs";
import { paginate } from "./lib/print.mjs";
import { inquiry, list, history, aging, layout } from "./lib/reports.mjs";
import { post, PostRefused } from "./lib/post.mjs";

function fail(code, message) {
  process.stderr.write("LEGACY01: " + message + "\n");
  process.exitCode = code;
}

function main(argv, env) {
  let req;
  let runTs;
  try {
    req = parseArgs(argv);
    runTs = runTimestamp(env);
  } catch (err) {
    if (err instanceof UsageError) {
      fail(2, err.message + "\n" + USAGE);
      return;
    }
    throw err;
  }

  let result;
  try {
    switch (req.command) {
      case "INQUIRY":
        result = inquiry(req.view, req.acctId);
        break;
      case "LIST":
        result = list(req.view, req.status, req.prefix);
        break;
      case "HISTORY":
        result = history(req.view, req.acctId, req.from, req.to);
        break;
      case "AGING":
        result = aging(req.view, req.asOf);
        break;
      case "LAYOUT":
        result = layout(req.view);
        break;
      case "POST": {
        const posted = post(req.view, req.acctId, req.type, req.amount);
        process.stderr.write("LEGACY01: POSTED TO TEMP COPY " + posted.tempFile + "\n");
        result = { body: posted.body, heading: null };
        break;
      }
      default:
        fail(1, "UNHANDLED COMMAND");
        return;
    }
  } catch (err) {
    if (err instanceof DataFileError) {
      fail(3, err.message);
      return;
    }
    if (err instanceof PostRefused) {
      fail(4, "POST REFUSED: " + err.message);
      return;
    }
    throw err;
  }

  process.stdout.write(paginate(req.command, req.view, runTs, result.body, result.heading));
  process.exitCode = 0;
}

try {
  main(process.argv.slice(2), process.env);
} catch (err) {
  fail(1, "INTERNAL ERROR " + (err && err.message ? err.message : String(err)));
}
