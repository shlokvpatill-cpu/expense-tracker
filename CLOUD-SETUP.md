# Phone app and cloud sync: one-time setup

With cloud sync on, the computer and the phone show the same accounts. Entries sync a few seconds after you save, whenever there is internet. Without internet, everything still works and syncs later.

The cloud is a free **Supabase** project that only you control. The free plan needs no card and includes 500 MB of entries and 1 GB of bill photos, which is years of use for one canteen.

---

## 1. Create the Supabase project (about 10 minutes, on the computer)

1. Go to **https://supabase.com** and click **Start your project**. Sign up with Google, GitHub or email.
2. Click **New project**.
   - **Name:** `canteen`
   - **Database password:** click *Generate a password* and keep it somewhere safe. The app does not need it.
   - **Region:** *South Asia (Mumbai)*
   - Click **Create new project** and wait about a minute while it starts.
3. In the left menu, open **SQL Editor** and click **New query**. Open the file **`supabase-setup.sql`** from the app folder in Notepad, copy everything, paste it into Supabase and click **Run**. It should say *Success*.
4. **Stop strangers from signing up.** Go to **Authentication → Sign In / Providers** and turn **off** *Allow new users to sign up*. Click **Save**.
5. **Create your login.** Go to **Authentication → Users → Add user → Create new user**. Enter an email and a password, tick **Auto Confirm User**, and click **Create user**.
   - Both owners can share one login, or you can add a user for each. Every user you add sees the same accounts.
6. **Copy the two connection details.** Go to **Project Settings → API Keys** (on some screens it is **Connect**):
   - the **Project URL**, which looks like `https://abcdefgh.supabase.co`
   - the **publishable key** (`sb_publishable_…`) or the older **anon public** key (`eyJ…`)

   **Never** use the *secret* or *service_role* key in the app.

## 2. Turn on sync on the computer first

The computer already has your data, so connect it before the phone.

1. Open the canteen app and go to **Settings & Backup → Cloud sync**.
2. Paste the **Project URL** and **key**, type the **email** and **password** from step 5, and click **Sign in & sync**.
3. The first sync uploads all your entries and bill photos, which can take a minute. When it's finished, the top bar shows **☁ Synced**.

## 3. Install the app on the Android phone

1. Copy **`dist\N.D. Patil Canteen-1.3.0.apk`** to the phone. You can use a USB cable, Google Drive, or send it to yourself on WhatsApp as a *Document*.
2. Tap the file on the phone. Android asks you to allow installing apps from that source (Files, Drive or WhatsApp). Allow it and tap **Install**.
   - Google Play Protect may say the app is from an *unknown developer*, because it isn't from the Play Store. Tap **More details → Install anyway**.
3. Open **N.D. Patil Canteen**, tap **☰ → Settings & Backup**, and sign in with the same URL, key, email and password. Your data downloads to the phone.
   - Tip: send yourself the URL and key on WhatsApp, then copy and paste them on the phone.

---

## Good to know

- **The ☁ button in the top bar** shows the sync state: *Synced*, *Saving…*, *Offline* or *Sign in*. Tap it to sync right away.
- **The same entry changed on both devices** before they synced: the device that syncs later keeps its version.
- **Bill photos** are uploaded from the device that took them. The other device downloads each photo the first time you open it.
- **On the phone**, *Take photo* opens the camera for bills. *Download backup* and *Export CSV* open the share sheet, so you can save to Drive or send on WhatsApp.
- **The free Supabase project pauses after 7 days with no use.** Daily use keeps it awake. If it pauses, log in to supabase.com and click **Restore project**. Your data is kept.
- **Lost or new phone:** install the app and sign in. Everything comes back.
- **Erase all data** in Settings erases the data on all your devices while sync is on.
- **Keep the `signing` folder safe.** Back it up with your data. Every future version of the phone app must be signed with the key in that folder, or it won't install over the old one.

## Building a new version of the phone app (for whoever maintains the app)

```
npm run android
```

This writes `dist\N.D. Patil Canteen-<version>.apk`. It needs Java 21 and the Android SDK in `%LOCALAPPDATA%\Android`, which are already set up on this computer.
