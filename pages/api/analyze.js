export const config = { api: { bodyParser: { sizeLimit: "10mb" } } };

const PROMPT = `You are an expert brand identity analyst. You will receive a logo image and SVG shape data.

Return EXACT JSON (no code fences, no commentary) with these keys:

1) "description": A single compelling paragraph (2-3 sentences) describing this logo — what it depicts, its visual character, and what kind of brand it suggests. Write it like a designer presenting to a client.

2) "complexity": "Basic" or "Complex"

3) "category": "Typographic Logos" | "Simple Graphic Logos" | "Complex Graphic Logos" | "Combination"

4) "layout": "Horizontal" | "Vertical" | "Square-ish" | "Unknown"

5) "nestedElements": true or false

6) "colors": array of hex colors detected in the design

7) "mood": a short phrase for the color/design mood (e.g. "bold and corporate", "warm and friendly")

8) "gradientSuggestion": {
  "recommended": true/false,
  "type": "linear" or "radial",
  "startColor": hex,
  "endColor": hex,
  "angle": 0-360,
  "reason": one sentence why
}

Return EXACT JSON only.`;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { imageBase64, shapeData } = req.body;
  if (!imageBase64) return res.status(400).json({ error: "No image provided" });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "OPENAI_API_KEY not configured" });

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify({
        model: "gpt-5.2",
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64," + imageBase64, detail: "low" },
              },
              {
                type: "text",
                text: PROMPT + (shapeData ? "\n\nShape data:\n" + shapeData : ""),
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: "No JSON in response" });

    return res.status(200).json(JSON.parse(match[0]));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
