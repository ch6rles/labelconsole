# Deploying to Railway

Label Console needs four things running at once: the **website**, the **worker** (stream polling, agents, scheduled jobs), a **Postgres database with pgvector**, and **Redis**. It also needs a **storage bucket** for uploaded files, so the website and worker can share them. Railway runs all of these in one project.

This takes about 20 minutes the first time. You only do it once. After that, pushes to the branch normally redeploy automatically; see "Deploying updates" if one doesn't.

**Cost:** Railway's Hobby plan is $5 a month and includes $5 of usage. With everything always on, expect roughly $20–30 a month in total. Railway shows live usage under the project's **Usage** tab.

## Before you start

Generate two secrets and keep them somewhere safe, such as a password manager. Losing `VAULT_MASTER_KEY` means the API keys stored in the app can't be decrypted.

```sh
openssl rand -base64 32   # → VAULT_MASTER_KEY
openssl rand -hex 32      # → SIGNING_SECRET
```

No terminal? Any "run OpenSSL online" page works for these two commands.

## 1. Create the project from GitHub

1. Sign in at [railway.com](https://railway.com) with GitHub, and pick the Hobby plan.
2. Click **New Project** → **Deploy from GitHub repo** → choose **labelconsole**. If it isn't listed, use **Configure GitHub App** to give Railway access to the repository.
3. Open the new service and go to **Settings**:
   - **Service name:** `web`
   - **Source → Branch:** the branch with this code, for example `claude/determined-cannon-4s2uzf`, or `main` once it's merged.

The first build may start and fail before the variables are set. That's expected; it redeploys once you add them.

## 2. Add the database, Redis and the bucket

On the project canvas, click **Create**, then add each of these. After adding each one, rename it under its **Settings** to the name shown, because the variables below refer to these names.

| Add | How | Rename to |
|---|---|---|
| Postgres with pgvector | **Template** → search `pgvector` → **pgvector-pg17** (or pg18) | `postgres` |
| Redis | **Database** → **Redis** | `redis` |
| File storage | **Bucket** (any region) | `bucket` |

Railway's standard Postgres doesn't include pgvector, which agent memory needs. That's why it's the pgvector template.

## 3. Give the website a public address

In **web → Settings → Networking**, click **Generate Domain** and enter port **3000**. You get an address like `web-production-1234.up.railway.app`.

## 4. Variables for the website

In **web → Variables**, click **Raw Editor** and paste the block below. Then fill in:

- the two secrets from "Before you start";
- your API keys. Leave any key you don't have empty; you can also add keys later in the app under Settings → Integrations.

```
LABEL_NAME="River Of Styxx"
APP_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
PORT=3000
HOSTNAME=0.0.0.0
VAULT_MASTER_KEY=paste-your-base64-secret-here
SIGNING_SECRET=paste-your-hex-secret-here
DATABASE_SUPERUSER_URL=${{postgres.DATABASE_URL}}
REDIS_URL=${{redis.REDIS_URL}}
STORAGE_DRIVER=s3
S3_BUCKET=${{bucket.BUCKET}}
S3_ENDPOINT=${{bucket.ENDPOINT}}
S3_REGION=${{bucket.REGION}}
S3_ACCESS_KEY_ID=${{bucket.ACCESS_KEY_ID}}
S3_SECRET_ACCESS_KEY=${{bucket.SECRET_ACCESS_KEY}}
S3_FORCE_PATH_STYLE=false
ANTHROPIC_API_KEY=
VOYAGE_API_KEY=
SPOTSCRAPER_API_KEY=
APIFY_API_TOKEN=
YOUTUBE_API_KEY=
```

`${{…}}` values are Railway references: Railway fills them in from the database, Redis and bucket, so you never copy passwords around. The app derives its own restricted database accounts from `DATABASE_SUPERUSER_URL`.

## 5. Add the worker

1. On the canvas, click **Create** → **GitHub Repo** → **labelconsole** again.
2. In its **Settings**:
   - **Service name:** `worker`
   - **Source → Branch:** the same branch as the website.
   - It needs **no** domain.
3. In **worker → Variables → Raw Editor**, paste this block. Fill in the **same** secrets and API keys as the website. Copy them from **web → Variables** with the eye icon. They must match exactly: `VAULT_MASTER_KEY` decrypts stored keys, and `SIGNING_SECRET` derives the database passwords.

```
LC_TARGET=worker
LABEL_NAME="River Of Styxx"
APP_URL=https://your-web-address.up.railway.app
VAULT_MASTER_KEY=paste-the-same-value-as-web
SIGNING_SECRET=paste-the-same-value-as-web
DATABASE_SUPERUSER_URL=${{postgres.DATABASE_URL}}
REDIS_URL=${{redis.REDIS_URL}}
STORAGE_DRIVER=s3
S3_BUCKET=${{bucket.BUCKET}}
S3_ENDPOINT=${{bucket.ENDPOINT}}
S3_REGION=${{bucket.REGION}}
S3_ACCESS_KEY_ID=${{bucket.ACCESS_KEY_ID}}
S3_SECRET_ACCESS_KEY=${{bucket.SECRET_ACCESS_KEY}}
S3_FORCE_PATH_STYLE=false
ANTHROPIC_API_KEY=paste-the-same-value-as-web
VOYAGE_API_KEY=paste-the-same-value-as-web
SPOTSCRAPER_API_KEY=paste-the-same-value-as-web
APIFY_API_TOKEN=paste-the-same-value-as-web
YOUTUBE_API_KEY=
```

Then check the worker has **no** `DATABASE_URL` or `DATABASE_SYSTEM_URL`. Railway sometimes adds `DATABASE_URL` by itself when services are linked; it would point the worker at a different database from the website.

Why the values are pasted directly rather than written as `${{web.…}}`: Railway leaves out a reference it can't resolve, for example to a sealed variable. The worker then starts without its secrets.

What the first line does:

- `LC_TARGET=worker` makes this service start as the worker. Both services run the same image, which contains the website and the worker; this variable picks one when the service starts.
- Both services create the database and apply updates each time they start. This is safe to repeat, and the order they start in doesn't matter.

## 6. Deploy and set up the label

1. Click **Deploy** at the top of the canvas to apply the changes.
2. Wait for **worker** to show **Active**. On the first start it creates the database, which takes about a minute.
3. Wait for **web** to show **Active**.
4. Open the website's address. The first visit shows **Set up River Of Styxx**: enter your name, email and password. This creates the owner account, and setup closes after that.
5. Invite the rest of your team under **Admin → Users**.

## Use your own address (labelconsole.riverofstyxx.com)

The app stays on Railway. Its worker, database and Redis need servers that are always on, which Netlify doesn't provide. Your domain only needs one DNS record pointing the subdomain at Railway. The main site at riverofstyxx.com stays on Netlify, untouched.

1. **Railway:**
   - Open **web → Settings → Networking**, click **Custom Domain**, enter `labelconsole.riverofstyxx.com` and port **3000**.
   - Railway shows a **CNAME** record to add, for example `labelconsole` → `abc123.up.railway.app`.
   - It sometimes also shows a **TXT** record for verification.
2. **Netlify:** riverofstyxx.com uses Netlify DNS, so its records are managed there, not at Namecheap.
   - Open **Domains → riverofstyxx.com → DNS settings → Add new record**.
   - Add the CNAME: type **CNAME**, name `labelconsole`, value the address Railway showed.
   - Add the TXT record the same way if Railway showed one.
3. Wait until Railway shows the domain as **verified** (usually a few minutes, up to an hour). Railway issues the HTTPS certificate on its own.
4. **Railway:**
   - Set `APP_URL=https://labelconsole.riverofstyxx.com` in **web → Variables** and **worker → Variables**.
   - Invite links and file links use this address.
   - Changing a variable redeploys the service.
5. Open `https://labelconsole.riverofstyxx.com/api/health` to check, then sign in. Sessions belong to each address, so everyone signs in once on the new one.

The Railway address keeps working as well.

## Deploying updates

After new code is pushed to the branch, open each service (**web**, then **worker**) and check that its latest deployment shows the newest commit message. If it doesn't, press **Cmd+K** (Ctrl+K on Windows) on the project canvas and choose **Deploy Latest Commit**, or use the **⋮** menu on the service. **Redeploy** on an old deployment rebuilds that same old commit, not the newest one.

To check which version is live, open `https://<your-address>/api/health`. `version` shows the first 7 characters of the running commit, which you can compare with the latest commit on GitHub.

## If something goes wrong

Open the service, then **Deployments → View logs**. The message at the end usually names the problem.

| You see | What it means |
|---|---|
| `Invalid environment configuration: VAULT_MASTER_KEY …` (on the worker) | The worker doesn't have the secrets. Paste the same `VAULT_MASTER_KEY` and `SIGNING_SECRET` as the website directly, not as `${{web.…}}` references. |
| `DATABASE_SUPERUSER_URL must be set` or `could not translate host name` | A reference doesn't match a service name. The services must be named exactly `web`, `postgres`, `redis` and `bucket`, or you must edit the `${{…}}` names to match. |
| `extension "vector" is not available` | The database isn't the pgvector template. Replace it with **pgvector-pg17**. |
| The website shows "This page couldn't load" | Open `https://<your-address>/api/health?deep=1`. It names what's wrong: the database (with the exact error), Redis, or a missing worker. A database error right after the first deploy usually clears within a minute. |
| Upload or download errors | The bucket variables aren't set on both services, or `S3_FORCE_PATH_STYLE` isn't `false`. |

**Forgot your password?** In **worker**, open the **⋮** menu and choose **Railway Shell**, or run `railway ssh` from the Railway CLI. Then run:

```sh
cd /opt/worker/apps/worker && node dist/owner.js --email you@example.com
```

It asks for a new password.
