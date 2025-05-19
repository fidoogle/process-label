// Netlify Function for processing label images
const fetch = require('node-fetch');
const { createReadStream } = require('fs');
const FormData = require('form-data');

exports.handler = async (event, context) => {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    // Parse the multipart form data
    const { image } = await parseMultipartForm(event);
    
    if (!image) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'No image uploaded' })
      };
    }

    // Convert image to base64 for Hugging Face API
    const base64Image = image.toString('base64');

    // Hugging Face Inference API call
    const huggingFaceApiKey = process.env.HUGGINGFACE_API_KEY;
    if (!huggingFaceApiKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'API key configuration error' })
      };
    }

    const modelUrl = "https://api-inference.huggingface.co/models/liuhaotian/llava-13b";
    const response = await fetch(modelUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${huggingFaceApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        inputs: base64Image,
        parameters: { max_new_tokens: 500 },
        options: { wait_for_model: true }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        statusCode: 500,
        body: JSON.stringify({ error: `Hugging Face API error: ${errorText}` })
      };
    }

    const result = await response.json();
    const modelOutput = result[0]?.generated_text || '';

    // Parse model output to extract description and ZPL
    let description = '';
    let zplCode = '';
    const descriptionMatch = modelOutput.match(/Description: ([\s\S]*?)(^ZPL:|\n\n|$)/i);
    if (descriptionMatch) {
      description = descriptionMatch[1].trim();
    }
    const zplMatch = modelOutput.match(/ZPL:\s*([\s\S]*)/i);
    if (zplMatch) {
      zplCode = zplMatch[1].trim();
    }

    if (!zplCode) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Failed to generate ZPL' })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ description, zpl: zplCode })
    };
  } catch (error) {
    console.error('Error processing image:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `Server error: ${error.message}` })
    };
  }
};

// Helper function to parse multipart form data
async function parseMultipartForm(event) {
  const busboy = require('busboy');
  return new Promise((resolve, reject) => {
    const result = {};
    
    const bb = busboy({ headers: event.headers });
    
    bb.on('file', (fieldname, file, info) => {
      const { filename, encoding, mimeType } = info;
      const chunks = [];
      
      file.on('data', (data) => {
        chunks.push(data);
      });
      
      file.on('end', () => {
        result[fieldname] = Buffer.concat(chunks);
      });
    });
    
    bb.on('field', (fieldname, value) => {
      result[fieldname] = value;
    });
    
    bb.on('finish', () => {
      resolve(result);
    });
    
    bb.on('error', (error) => {
      reject(error);
    });
    
    bb.write(Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8'));
    bb.end();
  });
}
