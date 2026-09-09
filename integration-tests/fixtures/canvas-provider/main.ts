/// <reference types="vite/client" />
import { mount } from 'svelte';
import ReconnectGraph from './ReconnectGraph.svelte';
import '@xyflow/svelte/dist/style.css';
mount(ReconnectGraph, { target: document.querySelector('#app')! });
