"""One-time OAuth setup: read-only Gmail access for one-time codes (OTP).

Put your Google OAuth client file at .job-automator/secrets/google_oauth_client.json
(run from the jobscan/ directory), then run this script and sign in with the
Gmail account the applications use. The token is written where the filler
reads it (filler_cli.py). IMAP with an app password, set in the app's
Settings, is the simpler alternative.
"""
from pathlib import Path
from google_auth_oauthlib.flow import InstalledAppFlow

SECRETS = Path(".job-automator/secrets")
CLIENT_SECRET = SECRETS / "google_oauth_client.json"
TOKEN_OUT = SECRETS / "gmail_token.json"   # what filler_cli.py reads

flow = InstalledAppFlow.from_client_secrets_file(
    str(CLIENT_SECRET),
    scopes=["https://www.googleapis.com/auth/gmail.readonly"],
)
creds = flow.run_local_server(port=0)
TOKEN_OUT.write_text(creds.to_json(), encoding="utf-8")
print(f"Token saved to {TOKEN_OUT}")
print(f"Account: {creds.token[:20]}...")
