import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'./tests/e2e',timeout:45000,workers:1,use:{baseURL:'http://127.0.0.1:5188',headless:true,permissions:['microphone'],launchOptions:{args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']}}});
