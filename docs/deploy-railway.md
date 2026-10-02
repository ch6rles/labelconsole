# Deploying to Railway

Label Console needs four things running at once: the **website**, the **worker** (stream polling, agents, scheduled jobs), a **Postgres database with pgvector**, and **Redis**. It also needs a **storage bucket** for uploaded files, so the website and worker can share them. Railway runs all of these in one project.

This takes about 20 minutes the first time. You only do it once; after that, every push to the branch redeploys automatically.

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
YOUTUBE_API_KEY=
```

`${{…}}` values are Railway references: Railway fills them in from the database, Redis and bucket, so you never copy passwords around. The app derives its own restricted database accounts from `DATABASE_SUPERUSER_URL`.

## 5. Add the worker

1. On the canvas, click **Create** → **GitHub Repo** → **labelconsole** again.
2. In its **Settings**:
   - **Service name:** `worker`
   - **Source → Branch:** the same branch as the website.
   - It needs **no** domain.
3. In **worker → Variables → Raw Editor**, paste this block as is. It points at the website's values, so there's nothing to fill in:

```
LC_TARGET=worker
LC_RELEASE_ON_START=1
LABEL_NAME=${{web.LABEL_NAME}}
APP_URL=${{web.APP_URL}}
VAULT_MASTER_KEY=${{web.VAULT_MASTER_KEY}}
SIGNING_SECRET=${{web.SIGNING_SECRET}}
DATABASE_SUPERUSER_URL=${{web.DATABASE_SUPERUSER_URL}}
REDIS_URL=${{web.REDIS_URL}}
STORAGE_DRIVER=s3
S3_BUCKET=${{web.S3_BUCKET}}
S3_ENDPOINT=${{web.S3_ENDPOINT}}
S3_REGION=${{web.S3_REGION}}
S3_ACCESS_KEY_ID=${{web.S3_ACCESS_KEY_ID}}
S3_SECRET_ACCESS_KEY=${{web.S3_SECRET_ACCESS_KEY}}
S3_FORCE_PATH_STYLE=false
ANTHROPIC_API_KEY=${{web.ANTHROPIC_API_KEY}}
VOYAGE_API_KEY=${{web.VOYAGE_API_KEY}}
SPOTSCRAPER_API_KEY=${{web.SPOTSCRAPER_API_KEY}}
YOUTUBE_API_KEY=${{web.YOUTUBE_API_KEY}}
```

What the first two lines do:

- `LC_TARGET=worker` makes Railway build the worker image from the same Dockerfile; without it, Railway would build the website.
- `LC_RELEASE_ON_START=1` makes the worker create the database and apply migrations each time it starts. This is safe to repeat.

## 6. Deploy and set up the label

1. Click **Deploy** at the top of the canvas to apply the changes.
2. Wait for **worker** to show **Active**. On the first start it creates the database, which takes about a minute.
3. Wait for **web** to show **Active**.
4. Open the website's address. The first visit shows **Set up River Of Styxx**: enter your name, email and password. This creates the owner account, and setup closes after that.
5. Invite the rest of your team under **Admin → Users**.

## If something goes wrong

Open the service, then **Deployments → View logs**. The message at the end usually names the problem.

| You see | What it means |
|---|---|
| `Invalid environment configuration: VAULT_MASTER_KEY …` | A variable is missing or malformed. Check the Raw Editor block, and that the secrets were pasted without spaces. |
| `DATABASE_SUPERUSER_URL must be set` or `could not translate host name` | A reference doesn't match a service name. The services must be named exactly `web`, `postgres`, `redis` and `bucket`, or you must edit the `${{…}}` names to match. |
| `extension "vector" is not available` | The database isn't the pgvector template. Replace it with **pgvector-pg17**. |
| The website shows "This page couldn't load" right after deploying | The worker hasn't finished creating the database yet. Wait for it to be **Active** and reload. |
| Upload or download errors | The bucket variables aren't set on both services, or `S3_FORCE_PATH_STYLE` isn't `false`. |

**Forgot your password?** In **worker**, open the **⋮** menu and choose **Railway Shell**, or run `railway ssh` from the Railway CLI. Then run:

```sh
node dist/owner.js --email you@example.com
```

It asks for a new password.
