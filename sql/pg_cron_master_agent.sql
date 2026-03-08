create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'master_intelligence_agent_every_30_min',
  '*/30 * * * *',
  $$
  select net.http_get(
    url := current_setting('app.settings.master_agent_url')
  );
  $$
);

comment on schedule master_intelligence_agent_every_30_min is 'Calls Master Intelligence Agent edge function every 30 minutes';

alter system set app.settings.master_agent_url = 'https://YOUR_PROJECT_REF.functions.supabase.co/master-intelligence-agent';

