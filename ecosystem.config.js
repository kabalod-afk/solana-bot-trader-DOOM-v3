/** PM2 en DigitalOcean Droplet — 1 proceso, reinicio automático, límite RAM. */
module.exports = {
  apps: [
    {
      name: 'doom-v3',
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '900M',
      kill_timeout: 10_000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
