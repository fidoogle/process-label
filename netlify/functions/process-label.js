// Netlify Function for processing label images
const fetch = require('node-fetch');
const { createReadStream } = require('fs');
const FormData = require('form-data');

// For debugging purposes
process.on('unhandledRejection', (reason, promise) => {
  console.log('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.log('Uncaught Exception:', error);
});

exports.handler = async (event, context) => {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    console.log('Function invoked with method:', event.httpMethod);
    
    // Try to parse the multipart form data
    let image;
    try {
      const formData = await parseMultipartForm(event);
      image = formData.image;
      console.log('Successfully parsed multipart form data');
    } catch (formError) {
      console.log('Error parsing multipart form:', formError.message);
      console.log('Attempting fallback method...');
      
      // Fallback: Try to process the request body directly
      if (event.body) {
        try {
          // Check if the body is JSON
          const bodyData = JSON.parse(event.body);
          if (bodyData.image) {
            // Handle base64 image directly from JSON
            image = Buffer.from(bodyData.image, 'base64');
            console.log('Successfully extracted image from JSON body');
          }
        } catch (jsonError) {
          console.log('Body is not JSON, trying as raw image data');
          // Last resort: treat body as raw image data
          image = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
        }
      }
    }
    
    if (!image) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'No image uploaded or could not parse image data' })
      };
    }

    // Convert image to base64 for Hugging Face API
    const base64Image = image.toString('base64');
    console.log(`Image converted to base64, length: ${base64Image.length}`);

    // Hugging Face Inference API call
    const huggingFaceApiKey = process.env.HUGGINGFACE_API_KEY;
    console.log(`API Key exists: ${!!huggingFaceApiKey}`);
    console.log(`API Key length: ${huggingFaceApiKey ? huggingFaceApiKey.length : 0}`);
    
    if (!huggingFaceApiKey) {
      console.log('Missing Hugging Face API key');
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'API key configuration error' })
      };
    }

    // Try a different model that's definitely available
    // const modelUrl = "https://api-inference.huggingface.co/models/microsoft/florence-2-base";
    // Other alternatives to try:
    const modelUrl = "https://api-inference.huggingface.co/models/Salesforce/blip-image-captioning-large";
    // const modelUrl = "https://api-inference.huggingface.co/models/nlpconnect/vit-gpt2-image-captioning";
    console.log(`Making request to Hugging Face API: ${modelUrl}`);
    
    // Prepare the request body for the image captioning model
    const requestBody = {
      // For most image models, just sending the base64 image is sufficient
      inputs: base64Image,
      // Simpler parameters for the image model
      parameters: { 
        max_new_tokens: 100
      },
      options: { wait_for_model: true }
    };
    
    let response;
    try {
      console.log('Sending request to Hugging Face API...');
      response = await fetch(modelUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${huggingFaceApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });
      
      console.log(`Hugging Face API response status: ${response.status}`);
    } catch (apiError) {
      console.error('Error calling Hugging Face API:', apiError);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: `API call failed: ${apiError.message}` })
      };
    }

    if (!response.ok) {
      try {
        const errorText = await response.text();
        console.log(`Hugging Face API error response: ${errorText}`);
        return {
          statusCode: 500,
          body: JSON.stringify({ error: `Hugging Face API error: ${errorText}` })
        };
      } catch (textError) {
        console.error('Error reading error response:', textError);
        return {
          statusCode: 500,
          body: JSON.stringify({ error: `Failed to read error response: ${textError.message}` })
        };
      }
    }

    console.log('Hugging Face API response was successful, parsing JSON...');
    let result;
    try {
      result = await response.json();
      console.log('API response parsed successfully');
    } catch (jsonError) {
      console.error('Error parsing API response as JSON:', jsonError);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: `Failed to parse API response: ${jsonError.message}` })
      };
    }
    
    console.log(`API result type: ${typeof result}`);
    console.log(`API result is array: ${Array.isArray(result)}`);
    if (Array.isArray(result)) {
      console.log(`API result array length: ${result.length}`);
    }
    
    // Handle different response formats from various models
    let modelOutput = '';
    if (Array.isArray(result) && result.length > 0) {
      // Some models return an array with generated_text property
      modelOutput = result[0]?.generated_text || '';
    } else if (typeof result === 'string') {
      // Some models return a string directly
      modelOutput = result;
    } else if (typeof result === 'object') {
      // Some models return an object with a caption or text property
      modelOutput = result.generated_text || result.caption || result.text || JSON.stringify(result);
    }
    
    console.log(`Model output: ${modelOutput}`);
    console.log(`Model output length: ${modelOutput.length}`);

    // For image captioning models, we'll use the caption as the description
    // and generate a simple ZPL code based on the description
    console.log('Processing image caption...');
    
    let description = modelOutput;
    let zplCode = '';
    
    try {
      // Generate a simple ZPL code based on the description
      // This is a basic template that will create a label with the description text
      zplCode = `^XA
^FO50,50^A0N,30,30^FD${description}^FS
^FO50,100^GB700,1,3^FS
^FO50,130^A0N,30,30^FDImage Analysis Result^FS
^FO50,180^A0N,25,25^FDCaption: ${description}^FS
^FO50,230^A0N,25,25^FDProcessed: ${new Date().toISOString()}^FS
^XZ`;
      
      console.log(`Generated ZPL code based on caption`);
    } catch (parseError) {
      console.error('Error generating ZPL code:', parseError);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: `Failed to generate ZPL: ${parseError.message}` })
      };
    }
    
    // Since we're generating the ZPL code ourselves, we'll always have it
    console.log('Successfully generated ZPL code from caption');
    
    console.log('Successfully extracted ZPL code, returning response');

    return {
      statusCode: 200,
      body: JSON.stringify({ description, zpl: zplCode })
    };
  } catch (error) {
    // More detailed error logging
    console.error('Error processing image:', error);
    console.error('Error stack:', error.stack);
    
    // Return a more informative error message
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: `Server error: ${error.message}`, 
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
        type: error.name
      })
    };
  }
};

// Helper function to parse multipart form data
async function parseMultipartForm(event) {
  // For debugging
  console.log('Request headers:', JSON.stringify(event.headers));
  console.log('Content-Type:', event.headers['content-type'] || event.headers['Content-Type']);
  
  // Check if the request is multipart/form-data
  const contentType = event.headers['content-type'] || event.headers['Content-Type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    console.log('Not a multipart/form-data request');
    throw new Error('Expected multipart/form-data request');
  }

  try {
    const busboy = require('busboy');
    return new Promise((resolve, reject) => {
      const result = {};
      
      // Create busboy instance with the request headers
      const bb = busboy({ 
        headers: {
          'content-type': contentType
        }
      });
      
      bb.on('file', (fieldname, file, info) => {
        console.log(`Processing file: ${fieldname}`);
        const chunks = [];
        
        file.on('data', (data) => {
          chunks.push(data);
        });
        
        file.on('end', () => {
          console.log(`File ${fieldname} received, size: ${chunks.reduce((acc, chunk) => acc + chunk.length, 0)} bytes`);
          result[fieldname] = Buffer.concat(chunks);
        });
      });
      
      bb.on('field', (fieldname, value) => {
        console.log(`Field received: ${fieldname}`);
        result[fieldname] = value;
      });
      
      bb.on('finish', () => {
        console.log('Finished parsing form data');
        resolve(result);
      });
      
      bb.on('error', (error) => {
        console.error('Error parsing form data:', error);
        reject(error);
      });
      
      // Convert the request body to a buffer
      const buffer = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
      console.log(`Request body size: ${buffer.length} bytes`);
      
      bb.write(buffer);
      bb.end();
    });
  } catch (error) {
    console.error('Error in parseMultipartForm:', error);
    throw error;
  }
}
