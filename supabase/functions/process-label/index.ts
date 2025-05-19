// File: functions/process-label/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const formData = await req.formData();
  const imageFile = formData.get("image");
  if (!imageFile || !(imageFile instanceof File)) {
    return new Response(JSON.stringify({ error: "No image uploaded" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Convert image to base64 for Hugging Face API
  const arrayBuffer = await imageFile.arrayBuffer();
  const base64Image = btoa(
    new Uint8Array(arrayBuffer).reduce(
      (data, byte) => data + String.fromCharCode(byte),
      ""
    )
  );

  // Hugging Face Inference API call
  const huggingFaceApiKey = Deno.env.get("HUGGINGFACE_API_KEY");
  if (!huggingFaceApiKey) {
    return new Response(JSON.stringify({ error: "API key configuration error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  const modelUrl = "https://api-inference.huggingface.co/models/liuhaotian/llava-13b";
  const response = await fetch(modelUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${huggingFaceApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      inputs: base64Image,
      parameters: { max_new_tokens: 500 },
      options: { wait_for_model: true },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return new Response(JSON.stringify({ error: `Hugging Face API error: ${errorText}` }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const result = await response.json();
  const modelOutput = result[0]?.generated_text || "";

  // Parse model output to extract description and ZPL
  let description = "";
  let zplCode = "";
  const descriptionMatch = modelOutput.match(/Description: ([\s\S]*?)(^ZPL:|\n\n|$)/i);
  if (descriptionMatch) {
    description = descriptionMatch[1].trim();
  }
  const zplMatch = modelOutput.match(/ZPL:\s*([\s\S]*)/i);
  if (zplMatch) {
    zplCode = zplMatch[1].trim();
  }

  if (!zplCode) {
    return new Response(JSON.stringify({ error: "Failed to generate ZPL" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ description, zpl: zplCode }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    });
});
