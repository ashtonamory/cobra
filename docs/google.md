# Connect Google

Cobra uses your Gmail, Drive and Calendar through a Google OAuth client that
you make in your own Google account. Cobra has no Google app of its own and no
server: the sign-in goes from your browser straight back to the agent on your
computer (`http://127.0.0.1:8787/google/callback`), and the agent keeps it in
`~/.config/cobra-agent/google.json`, sealed by the vault and readable only by you.

You do this once. It takes about ten minutes and costs nothing.

## 1. Make the client in Google Cloud

1. Open the [Google Cloud console](https://console.cloud.google.com/) and sign
   in with the Google account Cobra should use. Make a new project and name it
   Cobra.
2. Open **APIs & Services → Library**. Find and enable the **Gmail API**, the
   **Google Drive API** and the **Google Calendar API**.
3. Open **Google Auth Platform** (the OAuth consent screen) and press **Get
   started**. Give the app the name Cobra and your email, and pick
   **External**.
4. Under **Audience**, press **Publish app**. If you skip this, the app stays
   in Testing and Google ends the sign-in after 7 days.
5. Under **Clients**, press **Create client**. Pick the type **Desktop app**,
   name it Cobra, press **Create**, then **Download JSON**.

## 2. Give it to Cobra

1. In the desk app, open **Settings → Integrations → Google**.
2. Open the downloaded file, copy all of it, paste it in the box and press
   **Save**.
3. Press **Connect Google** and sign in on the page that opens.
4. Google says it has not verified the app. That is expected: the app is
   yours. Press **Advanced**, then **Go to Cobra**, and allow what it asks.

The first sign-in allows Cobra to make and open its own files in your Drive
and to send the email you allow. Calendar and Mail are separate: press **Turn
on** next to each when you want Cobra to read them. Mail also lets Cobra tidy
your mail (archive, label, trash) in batches you allow.

## Disconnect

- **Disconnect** signs out at Google and here. The client stays, so Connect
  Google works again at once.
- To remove the client too, delete it in Google Cloud (Clients), or run
  `cobra-agent uninstall --purge`.
- Google lists what Cobra can reach at
  [myaccount.google.com/connections](https://myaccount.google.com/connections).

## When it stops working

- **"connect again"**: Google refused the sign-in. You changed your password,
  removed Cobra's access, or the app is still in Testing (step 1.4). Press
  Connect Google.
- **"not set up"** after it worked: the client was deleted in Google Cloud.
  Make a new one (step 1.5) and paste it.
