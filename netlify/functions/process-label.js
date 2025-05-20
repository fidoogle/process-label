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
    // Debug all environment variables
    console.log('Environment variables available:', Object.keys(process.env).join(', '));
    
    // Try to get API key from various sources
    // 1. Environment variables (different case variations)
    // 2. Request headers (for development/testing only)
    // 3. Query parameters (for development/testing only)
    let replicateApiKey = process.env.REPLICATE_API_KEY || process.env.replicate_api_key || process.env.Replicate_Api_Key;
    
    // Check request headers for API key (ONLY FOR DEVELOPMENT/TESTING)
    if (!replicateApiKey && event.headers) {
      const authHeader = event.headers['x-replicate-api-key'] || event.headers['X-Replicate-Api-Key'];
      if (authHeader) {
        console.log('Found API key in request headers');
        replicateApiKey = authHeader;
      }
    }
    
    // Check query parameters for API key (ONLY FOR DEVELOPMENT/TESTING)
    if (!replicateApiKey && event.queryStringParameters) {
      const queryApiKey = event.queryStringParameters.api_key || event.queryStringParameters.apiKey;
      if (queryApiKey) {
        console.log('Found API key in query parameters');
        replicateApiKey = queryApiKey;
      }
    }
    
    console.log(`Replicate API Key exists: ${!!replicateApiKey}`);
    console.log(`REPLICATE_API_KEY from env: ${!!process.env.REPLICATE_API_KEY}`);
    
    if (!replicateApiKey) {
      console.log('Missing Replicate API key from all sources');
      return {
        statusCode: 500,
        body: JSON.stringify({ 
          error: 'Replicate API key configuration error',
          message: 'Please set the REPLICATE_API_KEY environment variable in your Netlify dashboard',
          availableEnvVars: Object.keys(process.env).filter(key => !key.includes('AWS') && !key.includes('SECRET')).join(', ')
        })
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
    
    // Process the Replicate API result
    console.log('Processing Replicate API result...');
    console.log(`Result: ${JSON.stringify(result).substring(0, 200)}...`);
    
    // For BLIP model, the result is a string or an array with a single string
    let modelOutput = '';
    if (typeof result === 'string') {
      modelOutput = result;
    } else if (Array.isArray(result) && result.length > 0) {
      modelOutput = result[0] || '';
    } else if (result && typeof result === 'object') {
      // Try to extract any text we can find
      modelOutput = result.caption || result.text || JSON.stringify(result);
    }
    
    console.log(`Model output: ${modelOutput}`);
    console.log(`Model output length: ${modelOutput.length}`);

    // Use the caption as the description and generate ZPL code
    console.log('Processing image caption...');
    
    let description = modelOutput || 'No description available';
    let zplCode = '';
    
    try {
      // Generate a more sophisticated ZPL code based on the description
      const date = new Date().toLocaleDateString();
      const time = new Date().toLocaleTimeString();
      
      // Create a shipping label with the description
      zplCode = `^XA

^FO50,50^GB700,1,3^FS
^FO50,75^A0N,35,35^FDShipping Label^FS
^FO50,130^GB700,1,3^FS

^FO50,150^A0N,30,30^FDItem Description:^FS
^FO50,190^A0N,25,25^FD${description.substring(0, 80)}^FS
${description.length > 80 ? `^FO50,220^A0N,25,25^FD${description.substring(80, 160)}^FS` : ''}

^FO50,260^GB700,1,2^FS
^FO50,280^A0N,25,25^FDProcessed: ${date} ${time}^FS

^FO50,330^BY3^BCN,100,Y,N,N
^FD>:${Math.floor(Math.random() * 1000000000).toString().padStart(9, '0')}^FS

^FO50,450^GB700,1,3^FS
^FO50,480^A0N,20,20^FDGenerated by Image Analysis^FS

^XZ`;
      
      console.log('Generated ZPL code based on caption');
    } catch (parseError) {
      console.error('Error generating ZPL code:', parseError);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: `Failed to generate ZPL: ${parseError.message}` })
      };
    }
    
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
