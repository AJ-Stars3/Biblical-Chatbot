import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, onSnapshot } from 'firebase/firestore';
// --- Global Variables (Provided by Canvas Environment) ---
// Note: These variables are assumed to be available in the runtime environment.
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;
const API_KEY = ""; // Canvas provides the API Key for the fetch call
// --- Constants ---
const FIREBASE_PATH = `/artifacts/${appId}/users/`;
const CHAT_COLLECTION = 'chat_data';
const CHAT_DOC_ID = 'conversation_data';
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${API_KEY}`;
const SYSTEM_PROMPT = `You are a knowledgeable, non-denominational Christian theologian and helpful guide named 'Theology Bot'.
Your primary source of knowledge is the Bible and traditional Christian doctrine.
RULES:
1. Always maintain a warm, encouraging, and supportive tone.
2. Keep answers concise, accurate, and focus on providing guidance or context based on common Christian understanding.
3. When referencing Scripture, quote or paraphrase clearly, but do not provide specific verse citations unless they are extremely well-known (e.g., John 3:16).
4. If a question involves sensitive, specific denominational doctrine, politely state that you focus on universally accepted core Christian beliefs and encourage consulting a local church leader.
5. DO NOT promote hatred, violence, or discrimination against any group or religion. Maintain absolute respect for all people and beliefs.
6. If asked for medical, legal, or financial advice, decline politely and state you are an AI focused on faith/theology only.`;
// --- Utility: Convert simple markdown to React JSX/HTML ---
const formatText = (text) => {
    // Simple bold conversion
    let formattedText = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    // Simple list conversion
    formattedText = formattedText.replace(/^- (.*)/gm, (match) => `<li class="ml-4 list-disc">${match.substring(2)}</li>`);
   
    // Wrap lists in ul tags if they exist
    if (formattedText.includes('<li')) {
        formattedText = `<ul>${formattedText}</ul>`;
    }
   
    return <div dangerouslySetInnerHTML={{ __html: formattedText }} />;
};
// --- Main App Component ---
export default function App() {
    // Firebase State
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);
   
    // App State
    const [chatHistory, setChatHistory] = useState([]);
    const [input, setInput] = useState('');
    const [isProcessing, setIsProcessing] = useState(false);
    const [isDbLoading, setIsDbLoading] = useState(true);
    const chatContainerRef = useRef(null);
    // --- Firebase Initialization and Authentication (Effect 1) ---
    useEffect(() => {
        try {
            const app = initializeApp(firebaseConfig);
            const firestore = getFirestore(app);
            const authInstance = getAuth(app);
           
            // Log for debugging Firebase operations
            // setLogLevel('Debug');
           
            setDb(firestore);
            setAuth(authInstance);
            const handleAuth = async (user) => {
                if (user) {
                    setUserId(user.uid);
                } else if (initialAuthToken) {
                    // Sign in with custom token if available
                    await signInWithCustomToken(authInstance, initialAuthToken);
                } else {
                    // Sign in anonymously as a fallback
                    const anonUser = await signInAnonymously(authInstance);
                    setUserId(anonUser.user.uid);
                }
                setIsAuthReady(true);
            };
            // Listener to handle initial state and subsequent changes
            const unsubscribe = onAuthStateChanged(authInstance, (user) => {
                handleAuth(user).catch(console.error);
            });
            return () => unsubscribe();
        } catch (e) {
            console.error("Firebase setup failed:", e);
        }
    }, []);
    // --- Firestore Listener (Effect 2: Data Fetching) ---
    useEffect(() => {
        // Only run if Firebase is ready and we have a userId
        if (!db || !isAuthReady || !userId) return;
        const userDocRef = doc(db, `${FIREBASE_PATH}${userId}/${CHAT_COLLECTION}/${CHAT_DOC_ID}`);
       
        setIsDbLoading(true);
        // Set up real-time listener for chat history
        const unsubscribe = onSnapshot(userDocRef, (docSnap) => {
            if (docSnap.exists() && docSnap.data().messages) {
                // Deserialize array and update state
                const data = docSnap.data().messages;
                // Since firestore doesn't natively store nested arrays (which we don't use here),
                // we just check if the data exists.
                setChatHistory(data);
            } else {
                // Initialize welcome message if no data exists
                if (chatHistory.length === 0) {
                     setChatHistory([{
                        role: "model",
                        text: "Hello! I am your Christian Wisdom Chatbot. I'm here to offer guidance, context, and information on faith, theology, and scripture. How may I help you today?",
                        timestamp: Date.now()
                    }]);
                }
            }
            setIsDbLoading(false);
        }, (error) => {
            console.error("Firestore read failed:", error);
            setIsDbLoading(false);
        });
        // Cleanup listener on unmount/dependency change
        return () => unsubscribe();
    }, [db, isAuthReady, userId]);
    // --- Scroll to bottom whenever messages update ---
    useEffect(() => {
        if (chatContainerRef.current) {
            chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
        }
    }, [chatHistory, isProcessing]);
    // --- Firestore Write Function ---
    const updateChatInFirestore = async (newHistory) => {
        if (!db || !userId) {
            console.error("Cannot write to Firestore: DB or User ID missing.");
            return;
        }
        try {
            const userDocRef = doc(db, `${FIREBASE_PATH}${userId}/${CHAT_COLLECTION}/${CHAT_DOC_ID}`);
            // Use setDoc with merge to overwrite the messages array
            await setDoc(userDocRef, { messages: newHistory, lastUpdated: Date.now() }, { merge: true });
        } catch (error) {
            console.error("Error writing chat history to Firestore:", error);
        }
    };
    // --- Gemini API Function ---
    const getGeminiResponse = async (userQuery) => {
        setIsProcessing(true);
        // Prepare conversation history for the API payload
        const historyForApi = chatHistory.map(({ role, text }) => ({
            role: role === 'model' ? 'model' : 'user', // Ensure roles are 'user' or 'model'
            parts: [{ text }]
        }));
       
        // Add the new user message to the local history and database payload
        const newUserMessage = { role: "user", text: userQuery, timestamp: Date.now() };
        const updatedHistory = [...chatHistory, newUserMessage];
       
        // Add the new user message to the history used for the API call
        historyForApi.push({ role: 'user', parts: [{ text: userQuery }] });
        // Update the local state immediately
        setChatHistory(updatedHistory);
       
        // Prepare API Payload
        const payload = {
            contents: historyForApi,
            systemInstruction: {
                parts: [{ text: SYSTEM_PROMPT }]
            },
            tools: [{ "google_search": {} }],
        };
        const maxRetries = 3;
        for (let i = 0; i < maxRetries; i++) {
            try {
                const response = await fetch(API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (!response.ok) {
                     if (response.status === 429 && i < maxRetries - 1) {
                        const delay = Math.pow(2, i) * 1000;
                        await new Promise(resolve => setTimeout(resolve, delay));
                        continue; // Retry
                    }
                    throw new Error(`API Request failed with status: ${response.status}`);
                }
                const result = await response.json();
                const candidate = result.candidates?.[0];
                if (candidate && candidate.content?.parts?.[0]?.text) {
                    let botText = candidate.content.parts[0].text;
                   
                    // Extract grounding sources (optional)
                    const groundingMetadata = candidate.groundingMetadata;
                    if (groundingMetadata && groundingMetadata.groundingAttributions) {
                         const sources = groundingMetadata.groundingAttributions
                            .map(attribution =>
                                attribution.web?.uri && attribution.web?.title
                                    ? `<a href="${attribution.web.uri}" target="_blank" class="text-blue-500 hover:underline">${attribution.web.title}</a>`
                                    : null
                            )
                            .filter(s => s !== null);
                        if (sources.length > 0) {
                            botText += `\n\n<p class="text-xs text-gray-500 mt-2">Grounded by sources: ${sources.slice(0, 3).join(', ')}</p>`;
                        }
                    }
                    const newBotMessage = { role: "model", text: botText, timestamp: Date.now() };
                    const finalHistory = [...updatedHistory, newBotMessage];
                   
                    // Update state and Firestore
                    setChatHistory(finalHistory);
                    await updateChatInFirestore(finalHistory);
                    break; // Success, exit retry loop
                } else {
                    throw new Error("Received empty or malformed response from the model.");
                }
            } catch (error) {
                console.error("Gemini API error:", error);
                const errorMessage = { role: "model", text: "I encountered an error trying to connect to my knowledge base. Please try again.", timestamp: Date.now() };
                const errorHistory = [...updatedHistory, errorMessage];
                setChatHistory(errorHistory);
                await updateChatInFirestore(errorHistory);
                break; // Error, exit retry loop
            }
        }
        setIsProcessing(false);
    };
    // --- Event Handler ---
    const handleSubmit = (event) => {
        event.preventDefault();
        const query = input.trim();
        if (query && !isProcessing && db && userId) {
            getGeminiResponse(query);
            setInput('');
        }
    };
    // --- Loading and Error States ---
    if (!isAuthReady) {
        return (
            <div className="flex justify-center items-center h-screen bg-gray-50">
                <p className="text-gray-600 font-semibold">
                    <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-blue-500 inline-block" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Initializing App and Authentication...
                </p>
            </div>
        );
    }
   
    // --- Render Component ---
    return (
        <div className="flex flex-col h-screen bg-gray-50 max-w-lg mx-auto shadow-xl">
            {/* Header */}
            <header className="bg-white shadow-md p-4 sticky top-0 z-10 border-b border-gray-200">
                <h1 className="text-2xl font-bold text-center text-gray-800">Christian Wisdom Chatbot</h1>
                <p className="text-xs text-center text-gray-500 mt-1">
                    User ID: <span className="font-mono bg-gray-100 px-1 rounded">{userId || 'N/A'}</span>
                </p>
                <div className="bg-yellow-100 border-l-4 border-yellow-400 text-yellow-700 p-2 mt-2 rounded-lg" role="alert">
                    <p className="text-xs font-medium">Disclaimer: AI is not a substitute for religious counsel.</p>
                </div>
            </header>
            {/* Chat Messages Container */}
            <div id="chat-container" ref={chatContainerRef} className="flex-1 overflow-y-auto p-4 space-y-4">
                {isDbLoading ? (
                    <div className="text-center p-8 text-gray-500">
                        <p>Loading conversation history...</p>
                    </div>
                ) : (
                    chatHistory.map((msg, index) => (
                        <div key={index} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                            <div className={`message max-w-[85%] p-3 rounded-xl shadow-md ${
                                msg.role === 'user'
                                    ? 'bg-blue-600 text-white rounded-br-sm'
                                    : 'bg-white text-gray-800 border border-gray-200 rounded-tl-sm'
                            }`}>
                                {formatText(msg.text)}
                            </div>
                        </div>
                    ))
                )}
               
                {/* Typing Indicator */}
                {isProcessing && (
                    <div className="flex justify-start">
                        <div className="message bg-white text-gray-600 p-3 rounded-xl shadow-md rounded-tl-sm">
                            <div className="loading-dot bg-gray-400 h-2 w-2 rounded-full inline-block mx-0.5 animate-bounce" style={{ animationDelay: '0s' }}></div>
                            <div className="loading-dot bg-gray-400 h-2 w-2 rounded-full inline-block mx-0.5 animate-bounce" style={{ animationDelay: '0.1s' }}></div>
                            <div className="loading-dot bg-gray-400 h-2 w-2 rounded-full inline-block mx-0.5 animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                        </div>
                    </div>
                )}
            </div>
            {/* Input Area */}
            <div className="p-4 bg-white border-t border-gray-200 sticky bottom-0 z-10">
                <form onSubmit={handleSubmit} className="flex gap-3">
                    <input
                        type="text"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        placeholder="Ask a question about the Bible, theology, or faith..."
                        className="flex-1 p-3 border border-gray-300 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500 transition duration-150 text-gray-700"
                        disabled={isProcessing || isDbLoading || !userId}
                        required
                    />
                    <button
                        type="submit"
                        className="bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 px-5 rounded-full shadow-lg transition duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                        disabled={isProcessing || input.trim() === '' || isDbLoading || !userId}
                    >
                        {isProcessing ? (
                            <span className="flex items-center">
                                <svg className="animate-spin h-5 w-5 mr-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                </svg>
                                Sending...
                            </span>
                        ) : (
                            'Send'
                        )}
                    </button>
                </form>
            </div>
        </div>
    );
}
