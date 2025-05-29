import json
import urllib3
import os

def handler(event, context):
    # Discord webhook URL
    webhook_url = "https://discord.com/api/webhooks/1082709454593724437/VOKVBFLrNOxpvlU3z_pdcRIrndHy_-1fT67GHlWwFRCZK4nSiLjRtHsh0JNTOwwzjz_y"
    
    # Create HTTP client
    http = urllib3.PoolManager()
    
    # Format the event details for Discord
    event_details = json.dumps(event, indent=2)
    message = {
        "content": f"🔔 **New EventBridge Event**\n```json\n{event_details}\n```"
    }
    
    # Send to Discord
    try:
        response = http.request(
            "POST",
            webhook_url,
            body=json.dumps(message).encode('utf-8'),
            headers={'Content-Type': 'application/json'}
        )
        print(f"Discord webhook response: {response.status}")
    except Exception as e:
        print(f"Error sending to Discord: {str(e)}")
    
    return {
        'statusCode': 200,
        'body': 'Event processed and notification sent to Discord!'
    } 