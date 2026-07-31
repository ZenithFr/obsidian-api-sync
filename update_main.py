import re

with open("obsidian-plugin/src/main.ts", "r") as f:
    content = f.read()

show_error_helper = """
  showError(context: string, err: any): void {
    console.error(`[ObsidianApiSync] ${context}:`, err);
    const status = (err as any)?.status ? ` [${(err as any).status}]` : "";
    const msg = err instanceof Error ? err.message : String(err);
    new Notice(`❌ ObsidianApiSync: ${context}${status} - ${msg}`);
  }
}"""
content = re.sub(r"}\s*$", show_error_helper, content)

def repl(m):
    return f"this.showError(\"{m.group(1)}\", {m.group(2)});"

content = re.sub(r"console\.error\('\[ObsidianApiSync\] ([^']*)',\s*([^)]*)\);", repl, content)

content = content.replace(
    "new Notice(`❌ ObsidianApiSync: ${message}`);", 
    "new Notice(`❌ ObsidianApiSync: ${status ? \"[\" + status + \"] \" : \"\"}${message}`);"
)

content = content.replace(
    "new Notice(`⚠️ ObsidianApiSync HTTP fallback failed: ${message}`);",
    "new Notice(`⚠️ ObsidianApiSync HTTP fallback failed${(err as any)?.status ? \" [\" + (err as any).status + \"]\" : \"\"}: ${message}`);"
)

with open("obsidian-plugin/src/main.ts", "w") as f:
    f.write(content)
