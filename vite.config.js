import { defineConfig } from 'vite';

// Göreli yollar: aynı derleme hem localhost'ta hem de bir alt klasörlü barındırmada (GitHub Pages vb.) çalışır.
export default defineConfig({ base: './' });
