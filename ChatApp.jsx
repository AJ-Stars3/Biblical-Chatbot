import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import {
  getAuth,
  signInAnonymously,
  signInWithCustomToken,
  onAuthStateChanged
} from 'firebase/auth';
import { getFirestore, doc, setDoc, onSnapshot } from 'firebase/firestore';

// -- Environment / Canvas-provided variables (if available) --
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;
const API_KEY = typeof __api_key !== 'undefined' ? __api_key : ''; // Canvas may inject this at runtime

// -- Constants --
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

// -- Utility functions (safe rendering, simple markdown-like handling) --
// Escape HTML to avoid XSS
const escapeHtml = (unsafe) =>
  String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

// Render simple inline formatting: **bold**
const renderInlineNodes = (text, keyPrefix = '') => {
  if (!text) return null;
  // escape first
  const escaped = escapeHtml(text);
  // split by **...**
  const parts = escaped.split(/\*\*(.*?)\*\*/g); // keeps capture groups
  return parts.map((part, idx) => {
    // parts in odd indexes are bold content
    if (idx % 2 === 1) {
      return (
        <strong key={`${keyPrefix}-b-${idx}`} className="font-semibold">
          {part}
        </strong>
      );
    } else {
      // convert any remaining newline characters to <br />
      const subparts = part.split('\n');
      return subparts.map((sp, sidx) => (
        <React.Fragment key={`${keyPrefix}-t-${idx}-${sidx}`}>
          {sp}
          {sidx < subparts.length - 1 ? <br /> : null}
        </React.Fragment>
      ));
    }
  });
};

// Convert a message string to React elements supporting simple lists and bold
const formatText = (text) => {
  if (typeof text !== 'string') return null;

  const lines = text.split('\n');
  const elements = [];
  let listBuffer = [];

  const flushList = () => {
    if (listBuffer.length > 0) {
      elements.push(
        <ul key={`ul-${elements.length}`} className="ml-4 list-disc space-y-1">
          {listBuffer.map((li, i) => (
            <li key={`li-${i}`} className="text-sm">
              {renderInlineNodes(li, `li-${i}`)}
            </li>
          ))}
        </ul>
      );
      listBuffer = [];
    }
  };

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      listBuffer.push(trimmed.substring(2));
    } else if (trimmed === '') {
      // empty line -> paragraph break
      flushList();
      elements.push(<div key={`br-${elements.length}`} style={{ height: 6 }} />);
    } else {
      flushList();
      elements.push(
        <div key={`p-${elements.length}`} className="text-sm leading-relaxed">
          {renderInlineNodes(line, `p-${elements.length}`)}
        </div>
      );
    }
  });

  flushList();

  return <div>{elements}</div>;
};

// -- Main App Component --
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

  // -- Firebase Initialization and Authentication --
  useEffect(() => {
    try {
      const app = initializeApp(firebaseConfig);
      const firestore = getFirestore(app);
      const authInstance = getAuth(app);

      setDb(firestore);
      setAuth(authInstance);

      const handleAuth = async (user) => {
        if (user) {
          setUserId(user.uid);
        } else if (initialAuthToken) {
          // Sign in with custom token if available and set uid from returned credential
          try {
            const credential = await signInWithCustomToken(authInstance, initialAuthToken);
            if (credential?.user?.uid) {
              setUserId(credential.user.uid);
            }
          } catch (err) {
            console.error('Custom token sign-in failed:', err);
          }
        } else {
          try {
            const anonUser = await signInAnonymously(authInstance);
            setUserId(anonUser.user.uid);
          } catch (err) {
            console.error('Anonymous sign-in failed:', err);
          }
        }
        setIsAuthReady(true);
      };

      const unsubscribe = onAuthStateChanged(authInstance, (user) => {
        handleAuth(user).catch(console.error);
      });

      return () => unsubscribe();
    } catch (e) {
      console.error('Firebase setup failed:', e);
    }
  }, []);

  // -- Firestore Listener --
  useEffect(() => {
    if (!db || !isAuthReady || !userId) return;

    setIsDbLoading(true);

    // Build doc reference with path segments rather than a single slash-leading string
    const userDocRef = doc(
      db,
      'artifacts',
      appId,
      'users',
      userId,
      CHAT_COLLECTION,
      CHAT_DOC_ID
    );

    const unsubscribe = onSnapshot(
      userDocRef,
      (docSnap) => {
        if (docSnap.exists()) {
          const data = docSnap.data();
          if (Array.isArray(data.messages) && data.messages.length > 0) {
            setChatHistory(data.messages);
          } else {
            // initialize local welcome message only if no existing server data
            setChatHistory((prev) => {
              if (prev.length === 0) {
                return [
                  {
                    role: 'model',
                    text:
                      "Hello! I am your Christian Wisdom Chatbot. I'm here to offer guidance, context, and information on faith, theology, and scripture. How may I help you today?",
                    timestamp: Date.now()
                  }
                ];
              }
              return prev;
            });
          }
        } else {
          // No document yet: set a local initial message
          setChatHistory((prev) => {
            if (prev.length === 0) {
              return [
                {
                  role: 'model',
                  text:
                    "Hello! I am your Christian Wisdom Chatbot. I'm here to offer guidance, context, and information on faith, theology, and scripture. How may I help you today?",
                  timestamp: Date.now()
                }
              ];
            }
            return prev;
          });
        }
        setIsDbLoading(false);
      },
      (error) => {
        console.error('Firestore read failed:', error);
        setIsDbLoading(false);
      }
    );

    return () => unsubscribe();
  }, [db, isAuthReady, userId]);

  // -- Scroll to bottom whenever messages update --
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [chatHistory, isProcessing]);

  // -- Firestore Write Function --
  const updateChatInFirestore = async (newHistory) => {
    if (!db || !userId) {
      console.error('Cannot write to Firestore: DB or User ID missing.');
      return;
    }
    try {
      const userDocRef = doc(
        db,
        'artifacts',
        appId,
        'users',
        userId,
        CHAT_COLLECTION,
        CHAT_DOC_ID
      );
      await setDoc(
        userDocRef,
        { messages: newHistory, lastUpdated: Date.now() },
        { merge: true }
      );
    } catch (error) {
      console.error('Error writing chat history to Firestore:', error);
    }
  };

  // -- Gemini API Function --
  const getGeminiResponse = async (userQuery) => {
    setIsProcessing(true);

    // Prepare new user message
    const newUserMessage = { role: 'user', text: userQuery, timestamp: Date.now() };

    // Create updated history snapshot (use current state plus new message)
    const updatedHistory = [...chatHistory, newUserMessage];

    // Update local state optimistically and persist
    setChatHistory(updatedHistory);
    updateChatInFirestore(updatedHistory).catch((e) =>
      console.error('Failed to persist optimistic user message:', e)
    );

    // Prepare conversation for API. Transform to a minimal expected shape.
    // (Check and adapt to the actual API schema you will use.)
    const historyForApi = updatedHistory.map(({ role, text }) => ({
      role: role === 'model' ? 'model' : 'user',
      parts: [{ text }]
    }));

    const payload = {
      contents: historyForApi,
      systemInstruction: {
        parts: [{ text: SYSTEM_PROMPT }]
      },
      // tools field left minimal; adapt according to API docs if you use external tools
      tools: [{ google_search: {} }]
    };

    const maxRetries = 3;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          // handle rate limiting with backoff
          if (response.status === 429 && attempt < maxRetries - 1) {
            const delay = Math.pow(2, attempt) * 1000;
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
          throw new Error(`API Request failed with status: ${response.status}`);
        }

        const result = await response.json();

        // defensive parsing: try to read candidate text in a few common shapes
        const candidate = result?.candidates?.[0] || result?.candidate || null;
        let botText = null;

        if (candidate?.content?.parts?.[0]?.text) {
          botText = candidate.content.parts[0].text;
        } else if (candidate?.text) {
          botText = candidate.text;
        } else if (typeof result?.output === 'string') {
          botText = result.output;
        }

        if (!botText) {
          throw new Error('Received empty or malformed response from the model.');
        }

        // If the API returns grounding metadata with attributions, append as plain text
        // (Avoid inserting raw HTML from the model to prevent XSS.)
        const grounding = candidate?.groundingMetadata || result?.groundingMetadata;
        if (grounding?.groundingAttributions && grounding.groundingAttributions.length > 0) {
          const sources = grounding.groundingAttributions
            .map((att) => {
              const title = att?.web?.title || att?.source || null;
              const uri = att?.web?.uri || att?.uri || null;
              if (title && uri) {
                return `- ${title}: ${uri}`;
              }
              if (uri) {
                return `- ${uri}`;
              }
              return null;
            })
            .filter(Boolean);
          if (sources.length > 0) {
            botText += '\n\nSources:\n' + sources.slice(0, 5).join('\n');
          }
        }

        const newBotMessage = { role: 'model', text: botText, timestamp: Date.now() };
        const finalHistory = [...updatedHistory, newBotMessage];

        setChatHistory(finalHistory);
        await updateChatInFirestore(finalHistory);

        break; // success
      } catch (error) {
        console.error('Gemini API error:', error);

        // On errors, add an error message to the conversation and persist
        const errorMessage = {
          role: 'model',
          text:
            "I encountered an error trying to connect to my knowledge base. Please try again later.",
          timestamp: Date.now()
        };
        const errorHistory = [...updatedHistory, errorMessage];
        setChatHistory(errorHistory);
        await updateChatInFirestore(errorHistory);

        break; // break retry loop on error (adjust if you want to retry on transient errors)
      }
    }

    setIsProcessing(false);
  };

  // -- Event Handler --
  const handleSubmit = (event) => {
    event.preventDefault();
    const query = input.trim();
    if (query && !isProcessing && db && userId) {
      getGeminiResponse(query);
      setInput('');
    }
  };

  // -- Loading and Auth States --
  if (!isAuthReady) {
    return (
      <div className="flex justify-center items-center h-screen bg-gray-50">
        <p className="text-gray-600 font-semibold">
          <svg
            className="animate-spin -ml-1 mr-3 h-5 w-5 text-blue-500 inline-block"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            aria-hidden
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
          Initializing App and Authentication...
        </p>
      </div>
    );
  }

  // -- Render Component --
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
            <div key={msg.timestamp || index} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`message max-w-[85%] p-3 rounded-xl shadow-md ${
                  msg.role === 'user'
                    ? 'bg-blue-600 text-white rounded-br-sm'
                    : 'bg-white text-gray-800 border border-gray-200 rounded-tl-sm'
                }`}
              >
                {formatText(msg.text)}
              </div>
            </div>
          ))
        )}

        {/* Typing Indicator */}
        {isProcessing && (
          <div className="flex justify-start">
            <div className="message bg-white text-gray-600 p-3 rounded-xl shadow-md rounded-tl-sm">
              <div className="loading-dot bg-gray-400 h-2 w-2 rounded-full inline-block mx-0.5 animate-bounce" style={{ animationDelay: '0s' }} />
              <div className="loading-dot bg-gray-400 h-2 w-2 rounded-full inline-block mx-0.5 animate-bounce" style={{ animationDelay: '0.1s' }} />
              <div className="loading-dot bg-gray-400 h-2 w-2 rounded-full inline-block mx-0.5 animate-bounce" style={{ animationDelay: '0.2s' }} />
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
            aria-label="Chat input"
          />
          <button
            type="submit"
            className="bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 px-5 rounded-full shadow-lg transition duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
            disabled={isProcessing || input.trim() === '' || isDbLoading || !userId}
          >
            {isProcessing ? (
              <span className="flex items-center">
                <svg className="animate-spin h-5 w-5 mr-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden>
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
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
