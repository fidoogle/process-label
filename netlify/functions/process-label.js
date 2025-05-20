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

    // Use Replicate API instead of Hugging Face
    const replicateApiKey = process.env.REPLICATE_API_KEY;
    console.log(`Replicate API Key exists: ${!!replicateApiKey}`);
    
    if (!replicateApiKey) {
      console.log('Missing Replicate API key');
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Replicate API key configuration error' })
      };
    }

    // Use Salesforce BLIP model on Replicate
    const replicateUrl = "https://api.replicate.com/v1/predictions";
    console.log(`Making request to Replicate API: ${replicateUrl}`);
    
    // Prepare the request body for Replicate
    const requestBody = {
      // Specify the model to use
      version: "2e1dddc8621f72155f24cf2e0adbde548458d3cab9f00c0139eea840d0ac4746", // Salesforce BLIP model
      // Input parameters
      input: {
        image: `data:image/jpeg;base64,${base64Image}`,
        caption: true
      }
    };
    
    let response;
    try {
      console.log('Sending request to Replicate API...');
      response = await fetch(replicateUrl, {
        method: 'POST',
        headers: {
          Authorization: `Token ${replicateApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });
      
      console.log(`Replicate API response status: ${response.status}`);
    } catch (apiError) {
      console.error('Error calling Replicate API:', apiError);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: `API call failed: ${apiError.message}` })
      };
    }

    if (!response.ok) {
      try {
        const errorText = await response.text();
        console.log(`Replicate API error response: ${errorText}`);
        return {
          statusCode: 500,
          body: JSON.stringify({ error: `Replicate API error: ${errorText}` })
        };
      } catch (textError) {
        console.error('Error reading error response:', textError);
        return {
          statusCode: 500,
          body: JSON.stringify({ error: `Failed to read error response: ${textError.message}` })
        };
      }
    }

    console.log('Replicate API response was successful, parsing JSON...');
    let predictionResponse;
    try {
      predictionResponse = await response.json();
      console.log('API response parsed successfully');
      console.log(`Prediction ID: ${predictionResponse.id}`);
      console.log(`Prediction status: ${predictionResponse.status}`);
    } catch (jsonError) {
      console.error('Error parsing API response as JSON:', jsonError);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: `Failed to parse API response: ${jsonError.message}` })
      };
    }
    
    // Replicate API is asynchronous, so we need to poll for the result
    const maxRetries = 10;
    let retries = 0;
    let result = null;
    
    while (retries < maxRetries) {
      console.log(`Polling for result, attempt ${retries + 1}/${maxRetries}`);
      
      try {
        const statusResponse = await fetch(`https://api.replicate.com/v1/predictions/${predictionResponse.id}`, {
          headers: {
            Authorization: `Token ${replicateApiKey}`
          }
        });
        
        if (!statusResponse.ok) {
          console.log(`Error checking prediction status: ${statusResponse.status}`);
          await new Promise(resolve => setTimeout(resolve, 1000));
          retries++;
          continue;
        }
        
        const statusData = await statusResponse.json();
        console.log(`Current status: ${statusData.status}`);
        
        if (statusData.status === 'succeeded') {
          result = statusData.output;
          break;
        } else if (statusData.status === 'failed') {
          return {
            statusCode: 500,
            body: JSON.stringify({ error: `Prediction failed: ${statusData.error || 'Unknown error'}` })
          };
        }
        
        // Wait before polling again
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (pollError) {
        console.error('Error polling for result:', pollError);
      }
      
      retries++;
    }
    
    if (!result) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Timed out waiting for prediction result' })
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
