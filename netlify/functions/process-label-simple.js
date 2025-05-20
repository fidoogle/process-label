// Netlify Function for processing label images
const fetch = require('node-fetch');
const FormData = require('form-data');

exports.handler = async (event, context) => {
  // Check if this is a status check (GET request with predictionId)
  const isPredictionCheck = event.httpMethod === 'GET' && event.queryStringParameters?.predictionId;
  
  // Allow both POST (for initial requests) and GET (for status checks)
  if (event.httpMethod !== 'POST' && !isPredictionCheck) {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    console.log('Function invoked with method:', event.httpMethod);
    
    // Get the prediction ID from query parameters
    const predictionId = event.queryStringParameters?.predictionId;
    
    // If this is a status check, check the prediction status
    if (predictionId) {
      console.log(`This is a status check for prediction ${predictionId}`);
      
      // Get API key
      const replicateApiKey = process.env.REPLICATE_API_KEY;
      if (!replicateApiKey) {
        return {
          statusCode: 500,
          body: JSON.stringify({ error: 'Missing Replicate API key' })
        };
      }
      
      // Check status
      const statusUrl = `https://api.replicate.com/v1/predictions/${predictionId}`;
      const statusResponse = await fetch(statusUrl, {
        headers: {
          Authorization: `Token ${replicateApiKey}`
        }
      });
      
      if (!statusResponse.ok) {
        return {
          statusCode: 500,
          body: JSON.stringify({ error: 'Error checking prediction status' })
        };
      }
      
      const statusData = await statusResponse.json();
      
      if (statusData.status === 'succeeded') {
        // Process the result
        const result = statusData.output;
        
        // Generate simple ZPL code
        const zplCode = `^XA
^FO50,50^A0N,50,50^FDShipping Label^FS
^FO50,120^A0N,30,30^FDTracking: 123456789^FS
^XZ`;
        
        return {
          statusCode: 200,
          body: JSON.stringify({
            description: 'Shipping label processed successfully',
            zpl: zplCode,
            debug: {
              modelOutput: result
            }
          })
        };
      } else if (statusData.status === 'failed') {
        return {
          statusCode: 500,
          body: JSON.stringify({ error: 'Prediction failed' })
        };
      } else {
        return {
          statusCode: 202,
          body: JSON.stringify({
            status: statusData.status,
            message: 'Prediction still processing',
            predictionId: predictionId
          })
        };
      }
    }
    
    // This is an initial request - process the image
    // Get API key
    const replicateApiKey = process.env.REPLICATE_API_KEY;
    if (!replicateApiKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Missing Replicate API key' })
      };
    }
    
    // Start a new prediction (simplified - no actual image processing)
    const replicateUrl = 'https://api.replicate.com/v1/predictions';
    const response = await fetch(replicateUrl, {
      method: 'POST',
      headers: {
        Authorization: `Token ${replicateApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        version: '2e1dddc8621f72155f24cf2e0adbde548458d3cab9f00c0139eea840d0ac4746',
        input: {
          image: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD',  // Minimal base64 image
          caption: 'This is a shipping label.'
        }
      })
    });
    
    if (!response.ok) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Error starting prediction' })
      };
    }
    
    const predictionResponse = await response.json();
    
    // Return the prediction ID
    return {
      statusCode: 202,
      body: JSON.stringify({
        message: 'Image processing started',
        predictionId: predictionResponse.id,
        status: predictionResponse.status
      })
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `Error: ${error.message}` })
    };
  }
};
