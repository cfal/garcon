import { invoke } from '@tauri-apps/api/core';
import { mountLauncher } from './launcher.js';

void mountLauncher(document, invoke);
