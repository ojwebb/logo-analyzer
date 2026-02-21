export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const id = process.env.VECTORIZER_AI_ID;
  const secret = process.env.VECTORIZER_AI_SECRET;
  if (!id || !secret)
    return res.status(500).json({ error: "Vectorizer credentials not configured" });

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks);

    const contentType = req.headers["content-type"] || "";
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch)
      return res.status(400).json({ error: "Missing multipart boundary" });

    const boundary = boundaryMatch[1];
    const bodyStr = rawBody.toString("binary");
    const parts = bodyStr.split("--" + boundary);

    let fileBuffer = null;
    let fileName = "image.png";
    let fileMime = "image/png";

    for (const part of parts) {
      if (!part.includes("Content-Disposition")) continue;
      const headerEndIdx = part.indexOf("\r\n\r\n");
      if (headerEndIdx === -1) continue;

      const headers = part.slice(0, headerEndIdx);
      const fnMatch = headers.match(/filename="([^"]+)"/);
      const ctMatch = headers.match(/Content-Type:\s*(\S+)/i);

      if (fnMatch) {
        fileName = fnMatch[1];
        if (ctMatch) fileMime = ctMatch[1].trim();

        const dataStart = headerEndIdx + 4;
        let dataEnd = part.length;
        if (part.endsWith("\r\n")) dataEnd -= 2;

        fileBuffer = Buffer.from(part.slice(dataStart, dataEnd), "binary");
        break;
      }
    }

    if (!fileBuffer)
      return res.status(400).json({ error: "No file found in upload" });

    const form = new FormData();
    const blob = new Blob([fileBuffer], { type: fileMime });
    form.append("image", blob, fileName);
    form.append("processing.max_colors", "0");
    form.append("output.size.scale", "1");

    const creds = Buffer.from(id + ":" + secret).toString("base64");

    const response = await fetch("https://vectorizer.ai/api/v1/vectorize", {
      method: "POST",
      headers: { Authorization: "Basic " + creds },
      body: form,
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({
        error: "Vectorizer.ai: " + (errText || response.statusText),
      });
    }

    const svg = await response.text();
    res.setHeader("Content-Type", "image/svg+xml");
    return res.status(200).send(svg);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
