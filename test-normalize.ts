function normalizeContentsSequence(contents: any[]): any[] {
  const merged: any[] = [];
  for (const msg of contents) {
    if (!msg || !msg.role || !Array.isArray(msg.parts)) {
      continue;
    }
    const validParts = msg.parts.filter((p: any) => p != null);
    if (validParts.length === 0) {
      continue;
    }

    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) {
      last.parts.push(...validParts);
    } else {
      merged.push({ ...msg, parts: validParts });
    }
  }
  return merged;
}

const input = [
  { role: "user", parts: [{ text: "Hello" }] },
  { role: "user", parts: [{ text: "World" }] },
  { role: "model", parts: [] },
  { role: "model", parts: [{ text: "I am a model" }] },
  { role: "user", parts: [{ text: "Q1" }] },
  { role: "user", parts: [{ text: "Q2" }] }
];

console.log(JSON.stringify(normalizeContentsSequence(input), null, 2));
