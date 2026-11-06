#!/usr/bin/env python3
"""Claude Status — Claude Code hook.

Called by Claude Code for every lifecycle event (see install.sh):
    claude-status-hook.py <EventName>   (hook JSON on stdin)

It keeps one small JSON file per session that the GNOME extension watches:
    ~/.cache/claude-status/sessions/<session_id>.json

For permission requests it can also wait for an answer from the top-bar card:
    requests/<id>.json   written here, read by the extension
    responses/<id>.json  written by the extension, read here
If the extension isn't running, or nobody answers in time, the hook steps aside
and Claude Code shows its normal prompt in the terminal.

The hook must never break Claude Code: every error is swallowed.
"""
import json
import os
import re
import sys
import time
import uuid

BASE = os.path.join(os.environ.get("XDG_CACHE_HOME", os.path.expanduser("~/.cache")), "claude-status")
SESSIONS = os.path.join(BASE, "sessions")
REQUESTS = os.path.join(BASE, "requests")
RESPONSES = os.path.join(BASE, "responses")
HEARTBEAT = os.path.join(BASE, "extension.alive")

WAIT_SECONDS = float(os.environ.get("CLAUDE_STATUS_WAIT", "60"))
HEARTBEAT_MAX_AGE = 20  # extension touches the heartbeat every 5s


# ---------------------------------------------------------------- helpers
def write_json(path, data):
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, path)


def read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def remove(path):
    try:
        os.remove(path)
    except OSError:
        pass


def extension_alive():
    try:
        return time.time() - os.path.getmtime(HEARTBEAT) < HEARTBEAT_MAX_AGE
    except OSError:
        return False


def pretty_model(model_id):
    """claude-opus-5-5 -> Opus 5.5, claude-3-5-sonnet-2024 -> Sonnet 3.5"""
    if not model_id:
        return ""
    m = re.search(r"(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?!\d)", model_id)
    if m:
        ver = m.group(2) + (f".{m.group(3)}" if m.group(3) else "")
        return f"{m.group(1).capitalize()} {ver}"
    m = re.search(r"claude-(\d+)(?:-(\d))?-(opus|sonnet|haiku)", model_id)
    if m:
        ver = m.group(1) + (f".{m.group(2)}" if m.group(2) else "")
        return f"{m.group(3).capitalize()} {ver}"
    return model_id


def model_from_transcript(path):
    """Last model id used in the transcript (reads only the tail)."""
    if not path or not os.path.exists(path):
        return ""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            f.seek(max(0, f.tell() - 96 * 1024))
            tail = f.read().decode("utf-8", "ignore")
        found = re.findall(r'"model"\s*:\s*"(claude-[^"]+)"', tail)
        return found[-1] if found else ""
    except Exception:
        return ""


def describe(tool, tool_input):
    """Short human description of what a tool call does (for the panel rows)."""
    ti = tool_input or {}
    if tool == "Bash":
        return ti.get("command", "")
    for key in ("file_path", "notebook_path", "path", "url", "pattern", "query"):
        if ti.get(key):
            return str(ti[key])
    return ""


# ---------------------------------------------------------------- session state
def update_session(sid, data, state, **extra):
    path = os.path.join(SESSIONS, sid + ".json")
    prev = read_json(path)
    now = time.time()

    model_id = data.get("model") if isinstance(data.get("model"), str) else ""
    if isinstance(data.get("model"), dict):
        model_id = data["model"].get("id", "")
    model_id = model_id or model_from_transcript(data.get("transcript_path")) or prev.get("model_id", "")

    started = prev.get("turn_started", now)
    if state == "thinking" and prev.get("state") in (None, "idle", "done"):
        started = now  # a new turn begins

    rec = {
        "session_id": sid,
        "state": state,
        "cwd": data.get("cwd") or prev.get("cwd", ""),
        "model_id": model_id,
        "model": pretty_model(model_id),
        "since": prev.get("since", now) if prev.get("state") == state else now,
        "turn_started": started,
        "ts": now,
        "tool": prev.get("tool", ""),
        "detail": prev.get("detail", ""),
        "request_id": "",
    }
    if state == "done":
        rec["finished_in"] = now - started
        rec["tool"] = rec["detail"] = ""
    rec.update(extra)
    write_json(path, rec)
    return rec


# ---------------------------------------------------------------- permission flow
def handle_permission(sid, data):
    tool = data.get("tool_name", "")
    tool_input = data.get("tool_input") or {}

    if not extension_alive():
        update_session(sid, data, "waiting", tool=tool, detail=describe(tool, tool_input))
        return None

    rid = uuid.uuid4().hex[:12]
    is_question = tool == "AskUserQuestion"
    request = {
        "id": rid,
        "session_id": sid,
        "kind": "question" if is_question else "permission",
        "tool": tool,
        "input": tool_input,
        "detail": describe(tool, tool_input),
        "cwd": data.get("cwd", ""),
        "has_suggestions": bool(data.get("permission_suggestions")),
        "ts": time.time(),
        "wait": 0 if is_question else WAIT_SECONDS,
    }
    rec = update_session(sid, data, "waiting", tool=tool, detail=request["detail"], request_id=rid)
    request["model"] = rec.get("model", "")
    req_path = os.path.join(REQUESTS, rid + ".json")
    res_path = os.path.join(RESPONSES, rid + ".json")
    write_json(req_path, request)

    # Questions are shown on the card but answered in the terminal.
    if is_question:
        return None

    decision = None
    deadline = time.time() + WAIT_SECONDS
    try:
        while time.time() < deadline:
            if os.path.exists(res_path):
                decision = read_json(res_path).get("decision")
                break
            time.sleep(0.15)
    finally:
        remove(req_path)
        remove(res_path)

    if decision not in ("allow", "always", "deny"):
        return None  # "terminal", dismissed, or timed out -> normal prompt

    update_session(sid, data, "thinking", tool=tool, detail=request["detail"])
    out = {"behavior": "allow" if decision != "deny" else "deny"}
    if decision == "deny":
        out["message"] = "The user denied this from the Claude Status top-bar card."
    if decision == "always" and data.get("permission_suggestions"):
        out["updatedPermissions"] = data["permission_suggestions"]
    return {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": out}}


# ---------------------------------------------------------------- main
def main():
    event = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        data = json.load(sys.stdin)
    except Exception:
        data = {}
    for d in (SESSIONS, REQUESTS, RESPONSES):
        os.makedirs(d, exist_ok=True)

    sid = re.sub(r"[^A-Za-z0-9_-]", "_", str(data.get("session_id") or "unknown"))
    path = os.path.join(SESSIONS, sid + ".json")

    if event == "SessionEnd":
        remove(path)
        return
    if event == "SessionStart":
        if not os.path.exists(path):
            update_session(sid, data, "idle")
        return
    if event == "UserPromptSubmit":
        update_session(sid, data, "thinking", tool="", detail="")
    elif event == "PreToolUse":
        tool = data.get("tool_name", "")
        if tool == "AskUserQuestion":
            handle_permission(sid, data)  # shows the question card; never blocks
        else:
            update_session(sid, data, "thinking", tool=tool, detail=describe(tool, data.get("tool_input")))
    elif event == "PostToolUse":
        update_session(sid, data, "thinking")
    elif event == "PermissionRequest":
        if data.get("tool_name") == "AskUserQuestion" and read_json(path).get("request_id"):
            return  # already shown from PreToolUse
        out = handle_permission(sid, data)
        if out:
            print(json.dumps(out))
    elif event == "Notification":
        ntype = data.get("notification_type", "")
        msg = (data.get("message") or "").lower()
        if (ntype == "permission_prompt" or (not ntype and "permission" in msg)) \
                and read_json(path).get("state") != "waiting":
            update_session(sid, data, "waiting", detail=data.get("message", ""))
    elif event == "Stop":
        update_session(sid, data, "done")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
