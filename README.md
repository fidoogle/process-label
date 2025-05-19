# Shipping Label to ZPL Converter

A web application that converts shipping label images to ZPL (Zebra Programming Language) format for thermal printers.

## Features

- Upload shipping label images
- Convert images to ZPL format
- View rendered label preview via Labelary
- Get description of the label content

## Technology Stack

- Frontend: HTML, CSS, JavaScript
- Backend: Supabase Edge Functions
- Deployment: Netlify (frontend) and Supabase (backend)

## Setup

1. Clone this repository
2. Configure your Supabase project URL and anon key
3. Deploy the Edge Function to Supabase
4. Deploy the frontend to Netlify

## Environment Variables

The following environment variables need to be set in your Netlify deployment:

- `SUPABASE_ANON_KEY`: Your Supabase project's anonymous key
