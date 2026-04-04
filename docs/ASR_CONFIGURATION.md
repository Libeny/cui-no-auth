# ASR Configuration Guide

CUI now supports multiple ASR (Automatic Speech Recognition) providers for voice input.

## Supported Providers

1. **Gemini** (Google Gemini 2.5 Flash) - Default
2. **GLM** (智谱 AI GLM-ASR-2512) - New!

## Configuration Methods

### Method 1: Environment Variables (Recommended)

Add to your `~/.bashrc` or `~/.zshrc`:

```bash
# For Gemini (Default)
export GOOGLE_API_KEY="your-gemini-api-key"

# For GLM (智谱 AI)
export ZHIPUAI_API_KEY="your-zhipu-api-key"
```

### Method 2: Configuration File

Edit `~/.cui/config.json`:

#### Using Gemini (Default)
```json
{
  "asr": {
    "provider": "gemini",
    "apiKey": "your-gemini-api-key",
    "model": "gemini-2.5-flash"
  }
}
```

#### Using GLM (智谱 AI)
```json
{
  "asr": {
    "provider": "glm",
    "apiKey": "your-zhipu-api-key",
    "model": "glm-asr-2512"
  }
}
```

## Getting API Keys

### Gemini API Key
1. Visit [Google AI Studio](https://aistudio.google.com/apikey)
2. Generate a free API key
3. Free tier: generous quota for personal use

### GLM API Key (智谱 AI)
1. Visit [智谱 AI Open Platform](https://open.bigmodel.cn)
2. Register and get API key
3. Free tier available

## API Documentation

- **Gemini ASR**: Uses Google Gemini models for speech recognition
- **GLM ASR**: [Official Documentation](https://docs.bigmodel.cn/cn/guide/models/sound-and-video/glm-asr-2512)

## Features Comparison

| Feature | Gemini | GLM |
|---------|--------|-----|
| Languages | 100+ languages | Chinese + 30+ languages |
| Dialects | Limited | Excellent (四川话、粤语、闽南语、吴语) |
| Accuracy (CER) | High | 0.0717 (Industry leading) |
| Free Tier | Generous | Available |
| Low Volume | Good | Excellent |

## Backward Compatibility

The old `gemini` configuration is still supported for backward compatibility:

```json
{
  "gemini": {
    "apiKey": "your-api-key",
    "model": "gemini-2.5-flash"
  }
}
```

However, we recommend using the new `asr` configuration for better flexibility.

## Testing

After configuration, test the ASR service:

1. Start CUI server
2. Check logs for: `ASR service initialized successfully`
3. Check which provider is active: logs will show `provider: 'gemini'` or `provider: 'glm'`
4. Test voice input in the web interface

## Troubleshooting

### Voice input not working
1. Check if API key is configured
2. Verify provider in logs
3. Test API health: `GET /api/gemini/health`

### GLM-specific issues
1. Ensure audio format is supported (webm, wav, mp3, etc.)
2. File size limit: 25 MB
3. Duration limit: 30 seconds

## Example Setup for GLM with bashrc

```bash
# In ~/.bashrc or ~/.zshrc
export ZHIPUAI_API_KEY="your-api-key-here"

# Optional: Configure to use GLM by default
# Add to ~/.cui/config.json:
# {
#   "asr": {
#     "provider": "glm"
#   }
# }
```

Then restart your shell and CUI server:
```bash
source ~/.bashrc  # or source ~/.zshrc
npm start
```
