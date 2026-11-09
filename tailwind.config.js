/**
 * Configurazione Tailwind del sito (prima era inline nella pagina, con il "Play CDN").
 * Il CSS viene compilato in assets/css/tailwind.css da `npm run build:assets`:
 * il sito non scarica più nulla da cdn.tailwindcss.com.
 */
export default {
    content: ['./index.html', './privacy.html'],
    theme: {
        extend: {
            colors: {
                nature: {
                    50: '#fcfaf7',
                    100: '#f5efe6',
                    200: '#eae0d2',
                    500: '#527965',
                    600: '#3f5e4e',
                    700: '#2f473c',
                    800: '#22332b',
                    900: '#17221d',
                },
                water: {
                    50: '#f4f8f9',
                    100: '#e4edf2',
                    500: '#4a8fa8',
                    600: '#387085',
                    700: '#295363',
                },
                warmth: {
                    50: '#fdfbf7',
                    100: '#f7f1e5',
                    200: '#eddcd2',
                    500: '#d5bdaf',
                }
            },
            fontFamily: {
                serif: ['"Cormorant Garamond"', 'Georgia', 'serif'],
                sans: ['"Plus Jakarta Sans"', 'sans-serif'],
                italic: ['"Cormorant Garamond"', 'Georgia', 'serif'],
            }
        }
    }
};
