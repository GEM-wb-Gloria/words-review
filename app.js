/* ----------------------------------------------------
   六级词霸 - Core Application Logic
   ---------------------------------------------------- */

document.addEventListener('DOMContentLoaded', () => {
    // Sound engine (Web Audio API)
    const AudioEngine = {
        ctx: null,
        init() {
            if (!this.ctx) {
                this.ctx = new (window.AudioContext || window.webkitAudioContext)();
            }
        },
        playCorrect() {
            try {
                this.init();
                const now = this.ctx.currentTime;
                
                // Soft bell chime: dual sine waves (E5 and B5) in harmony
                const osc1 = this.ctx.createOscillator();
                const osc2 = this.ctx.createOscillator();
                const gain = this.ctx.createGain();
                
                osc1.type = 'sine';
                osc1.frequency.setValueAtTime(659.25, now); // E5
                
                osc2.type = 'sine';
                osc2.frequency.setValueAtTime(987.77, now); // B5
                
                gain.gain.setValueAtTime(0.12, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
                
                osc1.connect(gain);
                osc2.connect(gain);
                gain.connect(this.ctx.destination);
                
                osc1.start(now);
                osc2.start(now);
                osc1.stop(now + 0.5);
                osc2.stop(now + 0.5);
            } catch (e) {
                console.warn("Failed to play correct chime via Web Audio:", e);
            }
        },
        playIncorrect() {
            try {
                this.init();
                const now = this.ctx.currentTime;
                
                // Softer low thud/buzz sound (avoiding annoying high buzzes)
                const osc = this.ctx.createOscillator();
                const gain = this.ctx.createGain();
                
                osc.type = 'sine';
                osc.frequency.setValueAtTime(150, now);
                osc.frequency.linearRampToValueAtTime(90, now + 0.25);
                
                gain.gain.setValueAtTime(0.15, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
                
                osc.connect(gain);
                gain.connect(this.ctx.destination);
                
                osc.start(now);
                osc.stop(now + 0.25);
            } catch (e) {
                console.warn("Failed to play incorrect chime via Web Audio:", e);
            }
        }
    };

    // State Variables
    let currentMode = 'words'; // 'words' or 'phrases'
    let currentGroupId = 1;
    let currentGroupItems = [];
    
    // Learning state
    let learningQueue = [];
    let learningIndex = 0;
    
    // Testing state
    let testingQueue = [];
    let testingIndex = 0;
    let testingScore = 0;
    let testingIncorrectList = [];
    let isIncorrectOnlySession = false;
    let testStartTime = 0;
    
    // Global User Progress (saved in localStorage)
    let userProgress = {
        words: {},      // group_id: 'completed' | 'in-progress'
        phrases: {}     // group_id: 'completed' | 'in-progress'
    };
    
    let errorBook = []; // array of items: { word/phrase, translation, phonetic, note, examples, type }
    
    let settings = {
        speechRate: 0.9,
        testMode: 'spelling' // 'spelling' or 'choice'
    };

    // DOM Cache
    const screens = {
        home: document.getElementById('home-screen'),
        learn: document.getElementById('learn-screen'),
        test: document.getElementById('test-screen'),
        result: document.getElementById('result-screen'),
        errorbook: document.getElementById('errorbook-screen')
    };
    
    const settingsModal = document.getElementById('settings-modal');

    // Native TTS Voice selection cache
    let preferredVoice = null;
    function loadVoices() {
        if (!window.speechSynthesis) return;
        const voices = window.speechSynthesis.getVoices();
        const candidates = voices.filter(v => v.lang.startsWith('en-') || v.lang === 'en');
        if (candidates.length > 0) {
            // Find premium natural voice if available, else standard US English
            const premium = candidates.find(v => v.name.includes('Google') || v.name.includes('Natural') || v.name.includes('Samantha') || v.name.includes('Daniel'));
            preferredVoice = premium || candidates.find(v => v.lang === 'en-US') || candidates.find(v => v.lang.startsWith('en')) || candidates[0];
        }
    }
    if (window.speechSynthesis) {
        loadVoices();
        if (window.speechSynthesis.onvoiceschanged !== undefined) {
            window.speechSynthesis.onvoiceschanged = loadVoices;
        }
    }

    // Speech Engine (Premium Human Audio with Native TTS Fallback)
    function speakText(text) {
        const cleanText = text.replace(/\(.*?\)/g, '').replace(/（.*?）/g, '').trim();
        if (!cleanText) return;
        
        // 1. Play high-quality human voice recording from Youdao's American English API
        const onlineUrl = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(cleanText)}&type=2`;
        const audio = new Audio(onlineUrl);
        
        let playedSuccessfully = false;
        audio.play()
            .then(() => {
                playedSuccessfully = true;
            })
            .catch(err => {
                console.warn("Online premium audio blocked or failed, falling back to local TTS:", err);
                fallbackTTS(cleanText);
            });
            
        // Safety Fallback: if audio fails to play within 1 second, run browser speech synthesis
        setTimeout(() => {
            if (!playedSuccessfully) {
                fallbackTTS(cleanText);
            }
        }, 1000);
    }

    // Local Browser speech synthesis fallback
    function fallbackTTS(cleanText) {
        if (!window.speechSynthesis) return;
        window.speechSynthesis.cancel();
        
        const utterance = new SpeechSynthesisUtterance(cleanText);
        utterance.lang = 'en-US';
        if (preferredVoice) {
            utterance.voice = preferredVoice;
        }
        utterance.rate = parseFloat(settings.speechRate) || 0.9;
        window.speechSynthesis.speak(utterance);
    }

    // ----------------------------------------------------
    // Storage helpers
    // ----------------------------------------------------
    function loadUserData() {
        try {
            const savedProgress = localStorage.getItem('cet6_progress');
            if (savedProgress) userProgress = JSON.parse(savedProgress);
            
            const savedErrorBook = localStorage.getItem('cet6_errorbook');
            if (savedErrorBook) errorBook = JSON.parse(savedErrorBook);
            
            const savedSettings = localStorage.getItem('cet6_settings');
            if (savedSettings) {
                settings = Object.assign(settings, JSON.parse(savedSettings));
                // Sync settings DOM
                document.getElementById('setting-speech-rate').value = settings.speechRate;
                document.getElementById('speech-rate-val').innerText = settings.speechRate;
                const testModeRadio = document.querySelector(`input[name="test-mode"][value="${settings.testMode}"]`);
                if (testModeRadio) testModeRadio.checked = true;
            }
        } catch (e) {
            console.error("Failed to load user data from localStorage:", e);
        }
    }

    function saveUserData() {
        try {
            localStorage.setItem('cet6_progress', JSON.stringify(userProgress));
            localStorage.setItem('cet6_errorbook', JSON.stringify(errorBook));
            localStorage.setItem('cet6_settings', JSON.stringify(settings));
        } catch (e) {
            console.error("Failed to save user data to localStorage:", e);
        }
    }

    // ----------------------------------------------------
    // Navigation & Screen Switcher
    // ----------------------------------------------------
    function switchScreen(screenId) {
        Object.keys(screens).forEach(key => {
            if (screens[key].id === screenId) {
                screens[key].classList.add('active');
            } else {
                screens[key].classList.remove('active');
            }
        });
        
        // Scroll back to top on entry
        const activeScreen = document.getElementById(screenId);
        if (activeScreen) activeScreen.scrollTop = 0;
    }

    // ----------------------------------------------------
    // Dashboard & Menu Rendering
    // ----------------------------------------------------
    function updateDashboardStats() {
        const db = WORDS_DATABASE;
        const totalWords = db.words.length;
        const totalPhrases = db.phrases.length;
        
        // Total count of vocabulary item is words + phrases
        document.getElementById('stats-total-words').innerText = totalWords + totalPhrases;
        
        // Calculate completed count
        let learnedCount = 0;
        
        // Check word groups
        db.grouped_words.forEach(g => {
            if (userProgress.words[g.group_id] === 'completed') {
                learnedCount += g.items.length;
            }
        });
        // Check phrase groups
        db.grouped_phrases.forEach(g => {
            if (userProgress.phrases[g.group_id] === 'completed') {
                learnedCount += g.items.length;
            }
        });
        
        document.getElementById('stats-learned-count').innerText = learnedCount;
        document.getElementById('stats-error-count').innerText = errorBook.length;
        
        // Progress fill
        const totalItems = totalWords + totalPhrases;
        const percentage = totalItems > 0 ? Math.round((learnedCount / totalItems) * 100) : 0;
        document.getElementById('stats-progress-percent').innerText = `${percentage}%`;
        document.getElementById('stats-progress-fill').style.width = `${percentage}%`;
    }

    function renderGroupList() {
        const container = document.getElementById('groups-container');
        container.innerHTML = '';
        
        const db = WORDS_DATABASE;
        const groups = currentMode === 'words' ? db.grouped_words : db.grouped_phrases;
        const progressObj = currentMode === 'words' ? userProgress.words : userProgress.phrases;
        
        groups.forEach(g => {
            const status = progressObj[g.group_id] || 'unstarted';
            
            const card = document.createElement('div');
            card.className = 'group-item-card';
            card.id = `group-card-${g.group_id}`;
            
            let statusText = '未开始';
            let statusClass = 'unstarted';
            if (status === 'in-progress') {
                statusText = '进行中';
                statusClass = 'in-progress';
            } else if (status === 'completed') {
                statusText = '已掌握';
                statusClass = 'completed';
            }
            
            card.innerHTML = `
                <div class="group-info">
                    <span class="group-title">${currentMode === 'words' ? '单词' : '词组'} - Group ${g.group_id}</span>
                    <span class="group-status-pill ${statusClass}">${statusText}</span>
                </div>
                <button class="group-action-btn" aria-label="开始">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:16px;height:16px;"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                </button>
            `;
            
            card.addEventListener('click', () => {
                startGroupLearning(g.group_id);
            });
            
            container.appendChild(card);
        });
    }

    // ----------------------------------------------------
    // Memorization Card Interface
    // ----------------------------------------------------
    function startGroupLearning(groupId) {
        currentGroupId = groupId;
        const db = WORDS_DATABASE;
        const groupData = currentMode === 'words' ? 
            db.grouped_words.find(g => g.group_id === groupId) : 
            db.grouped_phrases.find(g => g.group_id === groupId);
            
        if (!groupData) return;
        
        currentGroupItems = groupData.items;
        
        // Leitner queue setup: load all items into learning queue
        learningQueue = [...currentGroupItems];
        learningIndex = 0;
        
        // Update user progress to in-progress if not completed yet
        const progressObj = currentMode === 'words' ? userProgress.words : userProgress.phrases;
        if (progressObj[groupId] !== 'completed') {
            progressObj[groupId] = 'in-progress';
            saveUserData();
        }
        
        document.getElementById('learn-group-title').innerText = `${currentMode === 'words' ? '单词' : '词组'} - 第 ${groupId} 组`;
        
        // Reset card state (unflipped)
        document.getElementById('flashcard').classList.remove('flipped');
        
        showNextLearningItem();
        switchScreen('learn-screen');
    }

    function showNextLearningItem() {
        if (learningQueue.length === 0) {
            // All items studied! Trigger assessment
            startGroupAssessment();
            return;
        }
        
        // Wrap index if somehow out of bounds
        if (learningIndex >= learningQueue.length) {
            learningIndex = 0;
        }
        
        const item = learningQueue[learningIndex];
        const textKey = item.word || item.phrase;
        
        // Calculate original progress in the group
        const totalGroupSize = currentGroupItems.length;
        const studiedSet = new Set(currentGroupItems.filter(gItem => !learningQueue.includes(gItem)));
        const progressPct = Math.round((studiedSet.size / totalGroupSize) * 100);
        
        document.getElementById('learn-progress-counter').innerText = `${studiedSet.size + 1} / ${totalGroupSize}`;
        document.getElementById('learn-progress-fill').style.width = `${progressPct}%`;
        
        // Setup card content
        document.getElementById('learn-card-category').innerText = item.category.split('・')[1] || item.category;
        document.getElementById('learn-word-text').innerText = textKey;
        
        // Phonetics
        const phoneticEl = document.getElementById('learn-word-phonetic');
        if (item.phonetic) {
            phoneticEl.innerText = item.phonetic;
            phoneticEl.style.display = 'inline-block';
        } else {
            phoneticEl.style.display = 'none';
        }
        
        // Back card content
        document.getElementById('learn-back-word').innerText = textKey;
        document.getElementById('learn-word-translation').innerText = item.translation;
        
        // Note (Collocations / confusion hints)
        const noteContainer = document.getElementById('learn-note-container');
        const noteEl = document.getElementById('learn-word-note');
        if (item.note) {
            noteEl.innerText = item.note;
            noteContainer.style.display = 'block';
        } else {
            noteContainer.style.display = 'none';
        }
        
        // Examples
        const examplesList = document.getElementById('learn-examples-list');
        examplesList.innerHTML = '';
        if (item.examples && item.examples.length > 0) {
            item.examples.forEach(ex => {
                const itemDiv = document.createElement('div');
                itemDiv.className = 'example-item';
                itemDiv.innerHTML = `
                    <div class="en">${ex.en}</div>
                    <div class="cn">${ex.cn}</div>
                `;
                examplesList.appendChild(itemDiv);
            });
            document.querySelector('.examples-section').style.display = 'block';
        } else {
            document.querySelector('.examples-section').style.display = 'none';
        }
        
        // Unflip card
        document.getElementById('flashcard').classList.remove('flipped');
        
        // Voice auto-play
        setTimeout(() => {
            speakText(textKey);
        }, 300);
    }

    // Flashcard interaction events
    document.getElementById('reveal-card-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        document.getElementById('flashcard').classList.add('flipped');
    });
    
    document.getElementById('flip-back-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        document.getElementById('flashcard').classList.remove('flipped');
    });
    
    document.getElementById('flashcard').addEventListener('click', () => {
        document.getElementById('flashcard').classList.toggle('flipped');
    });

    document.getElementById('learn-speak-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        const textKey = currentGroupItems[learningIndex]?.word || currentGroupItems[learningIndex]?.phrase;
        if (textKey) speakText(textKey);
    });

    // Leitner learning feedback
    document.getElementById('learn-know-btn').addEventListener('click', () => {
        // "Got it": Remove from current learningQueue
        learningQueue.splice(learningIndex, 1);
        // Do not increment learningIndex since we removed current item, the next one slides into the index
        showNextLearningItem();
    });

    document.getElementById('learn-dontknow-btn').addEventListener('click', () => {
        // "Forget": Keep it, but push it to the end of learning queue so user encounters it again
        const forgottenItem = learningQueue.splice(learningIndex, 1)[0];
        learningQueue.push(forgottenItem);
        // Again, next item slides into current index
        showNextLearningItem();
    });

    // ----------------------------------------------------
    // Testing / Assessment System
    // ----------------------------------------------------
    function startGroupAssessment() {
        testingQueue = shuffleArray([...currentGroupItems]);
        testingIndex = 0;
        testingScore = 0;
        testingIncorrectList = [];
        isIncorrectOnlySession = false;
        testStartTime = Date.now();
        
        document.getElementById('test-title').innerText = `单元测试`;
        setupNextTestQuestion();
        switchScreen('test-screen');
    }

    function startIncorrectOnlyAssessment() {
        testingQueue = shuffleArray([...testingIncorrectList]);
        testingIndex = 0;
        // Keep tracking new errors for subsequent rounds
        testingIncorrectList = [];
        isIncorrectOnlySession = true;
        
        document.getElementById('test-title').innerText = `错词重练`;
        setupNextTestQuestion();
        switchScreen('test-screen');
    }

    function setupNextTestQuestion() {
        if (testingIndex >= testingQueue.length) {
            // Test ended, display result
            showAssessmentResult();
            return;
        }
        
        const item = testingQueue[testingIndex];
        const textKey = item.word || item.phrase;
        
        // Progress display
        const totalQ = testingQueue.length;
        document.getElementById('test-progress-counter').innerText = `${testingIndex + 1} / ${totalQ}`;
        const pct = Math.round((testingIndex / totalQ) * 100);
        document.getElementById('test-progress-fill').style.width = `${pct}%`;
        
        // Determine Question Type randomly
        // Type 1: English -> Chinese (Multiple choice)
        // Type 2: Chinese -> English (Bubble spelling or multiple choice)
        const qType = Math.random() < 0.5 ? 'eng_to_chn' : 'chn_to_eng';
        
        const promptEl = document.getElementById('test-question-prompt');
        const typeBadge = document.getElementById('test-type-badge');
        const optionsArea = document.getElementById('test-options-container');
        const spellingArea = document.getElementById('test-spelling-container');
        const audioWrapper = document.getElementById('test-audio-container');
        
        // Clear templates
        optionsArea.innerHTML = '';
        spellingArea.style.display = 'none';
        optionsArea.style.display = 'none';
        audioWrapper.style.display = 'none';
        
        if (qType === 'eng_to_chn') {
            typeBadge.innerText = "根据英文选中文";
            promptEl.innerText = textKey;
            
            // Speak the English word
            audioWrapper.style.display = 'flex';
            speakText(textKey);
            
            // Generate multiple choice options
            optionsArea.style.display = 'flex';
            generateChoiceOptions(item, 'translation');
        } else {
            typeBadge.innerText = "根据中文答英文";
            promptEl.innerText = item.translation;
            
            if (settings.testMode === 'spelling') {
                // bubble spelling challenge
                spellingArea.style.display = 'flex';
                initializeSpellingGame(item);
            } else {
                // multiple choice
                optionsArea.style.display = 'flex';
                generateChoiceOptions(item, 'english');
            }
        }
    }

    // Helper: generate 4 choice options (English or Chinese)
    function generateChoiceOptions(correctItem, targetField) {
        const optionsArea = document.getElementById('test-options-container');
        optionsArea.innerHTML = '';
        
        const correctText = targetField === 'translation' ? 
            correctItem.translation : 
            (correctItem.word || correctItem.phrase);
            
        // Get distractor database: all items in the mode
        const allItems = currentMode === 'words' ? WORDS_DATABASE.words : WORDS_DATABASE.phrases;
        const filteredList = allItems.filter(i => (i.word || i.phrase) !== (correctItem.word || correctItem.phrase));
        
        const distractorCount = 3;
        const distractors = [];
        
        // Shuffle and pick 3 unique distractors
        const shuffledDist = shuffleArray([...filteredList]);
        for (let i = 0; i < shuffledDist.length; i++) {
            const textVal = targetField === 'translation' ? 
                shuffledDist[i].translation : 
                (shuffledDist[i].word || shuffledDist[i].phrase);
                
            if (textVal && textVal !== correctText && !distractors.includes(textVal)) {
                distractors.push(textVal);
            }
            if (distractors.length >= distractorCount) break;
        }
        
        // Fallback distractors if somehow database is small
        while (distractors.length < distractorCount) {
            distractors.push("六级核心词汇/短语");
        }
        
        const optionsList = [correctText, ...distractors];
        const shuffledOptions = shuffleArray(optionsList);
        
        shuffledOptions.forEach((optionText, idx) => {
            const btn = document.createElement('button');
            btn.className = 'option-btn';
            btn.id = `option-${idx}`;
            btn.innerText = optionText;
            
            btn.addEventListener('click', () => {
                // Disable all option buttons immediately to prevent double tap
                document.querySelectorAll('.option-btn').forEach(b => b.style.pointerEvents = 'none');
                
                const isCorrect = (optionText === correctText);
                if (isCorrect) {
                    btn.classList.add('correct');
                    handleAnswerFeedback(true);
                } else {
                    btn.classList.add('incorrect');
                    // Find correct button and color it too
                    document.querySelectorAll('.option-btn').forEach(b => {
                        if (b.innerText === correctText) b.classList.add('correct');
                    });
                    handleAnswerFeedback(false);
                }
            });
            optionsArea.appendChild(btn);
        });
    }

    // Helper: Spelling Bubbles mini game
    let spellingSlotsState = [];
    let spellingTargetWord = "";
    
    function initializeSpellingGame(item) {
        const slotsContainer = document.getElementById('spelling-slots');
        const bubblesContainer = document.getElementById('spelling-bubbles');
        
        slotsContainer.innerHTML = '';
        bubblesContainer.innerHTML = '';
        
        const target = (item.word || item.phrase).trim();
        spellingTargetWord = target;
        spellingSlotsState = [];
        
        // Clean characters list for bubble generation
        // letters only, ignore spaces or special characters in target check, but we keep spaces as fixed characters
        const charArray = target.split('');
        
        // Render slots
        charArray.forEach((char, index) => {
            const slot = document.createElement('div');
            slot.className = 'letter-slot';
            slot.id = `slot-${index}`;
            
            // If it is space or hyphen, prefill it so user doesn't have to guess punctuation
            if (char === ' ' || char === '-') {
                slot.innerText = char;
                slot.classList.add('filled');
                spellingSlotsState[index] = char;
            } else {
                slot.innerHTML = '&nbsp;';
                spellingSlotsState[index] = null;
            }
            slotsContainer.appendChild(slot);
        });
        
        // Gather bubbles
        // Only bubble characters that the user needs to select (excludes spaces and punctuation)
        const alphabetOnly = charArray.filter(c => c !== ' ' && c !== '-');
        
        // Add 2-3 distractor random letters for extra fun and premium challenge
        const alphabet = 'abcdefghijklmnopqrstuvwxyz';
        const distractorCount = Math.min(3, Math.max(1, 10 - alphabetOnly.length));
        for (let i = 0; i < distractorCount; i++) {
            const randChar = alphabet.charAt(Math.floor(Math.random() * alphabet.length));
            alphabetOnly.push(randChar);
        }
        
        const shuffledBubbles = shuffleArray(alphabetOnly);
        
        shuffledBubbles.forEach((char, idx) => {
            const bubble = document.createElement('button');
            bubble.className = 'bubble-btn';
            bubble.innerText = char;
            bubble.dataset.char = char;
            bubble.id = `bubble-${idx}`;
            
            bubble.addEventListener('click', () => {
                placeLetterInNextSlot(char, bubble);
            });
            bubblesContainer.appendChild(bubble);
        });
    }

    function placeLetterInNextSlot(char, bubbleButton) {
        // Find first empty slot
        const emptySlotIndex = spellingSlotsState.findIndex(val => val === null);
        if (emptySlotIndex === -1) return;
        
        // Fill slot
        spellingSlotsState[emptySlotIndex] = char;
        const slotEl = document.getElementById(`slot-${emptySlotIndex}`);
        slotEl.innerText = char;
        slotEl.classList.add('filled');
        
        // Keep track of which bubble button was used in which slot
        bubbleButton.classList.add('used');
        slotEl.dataset.bubbleId = bubbleButton.id;
        
        // Check if all slots are filled
        const remainingEmpty = spellingSlotsState.findIndex(val => val === null);
        if (remainingEmpty === -1) {
            // Lock all interactions
            document.querySelectorAll('.bubble-btn').forEach(b => b.style.pointerEvents = 'none');
            
            // Check spelling correctness
            const userSpelling = spellingSlotsState.join('');
            const isCorrect = (userSpelling.toLowerCase() === spellingTargetWord.toLowerCase());
            
            if (isCorrect) {
                handleAnswerFeedback(true);
            } else {
                // Show shake animation
                const stage = document.getElementById('test-question-area');
                stage.classList.add('shake-animation');
                setTimeout(() => stage.classList.remove('shake-animation'), 400);
                
                // Color slots red
                document.querySelectorAll('.letter-slot').forEach(s => s.style.color = 'var(--danger)');
                
                // Reveal the correct spelling in a small banner or overlay
                const promptEl = document.getElementById('test-question-prompt');
                const origPrompt = promptEl.innerText;
                promptEl.innerText = `正确答案: ${spellingTargetWord}`;
                promptEl.style.color = 'var(--success)';
                
                setTimeout(() => {
                    promptEl.innerText = origPrompt;
                    promptEl.style.color = '';
                    handleAnswerFeedback(false);
                }, 1800);
            }
        }
    }

    // Letter Spelling Controls
    document.getElementById('spelling-delete-btn').addEventListener('click', () => {
        // Find last filled slot that isn't prefilled (space or hyphen)
        for (let i = spellingSlotsState.length - 1; i >= 0; i--) {
            const char = spellingTargetWord[i];
            if (char !== ' ' && char !== '-' && spellingSlotsState[i] !== null) {
                // Remove letter
                spellingSlotsState[i] = null;
                const slotEl = document.getElementById(`slot-${i}`);
                slotEl.innerHTML = '&nbsp;';
                slotEl.classList.remove('filled');
                
                // Restore bubble
                const bubbleId = slotEl.dataset.bubbleId;
                if (bubbleId) {
                    const bubble = document.getElementById(bubbleId);
                    if (bubble) bubble.classList.remove('used');
                }
                delete slotEl.dataset.bubbleId;
                break;
            }
        }
    });

    document.getElementById('spelling-reset-btn').addEventListener('click', () => {
        // Reset all editable slots
        spellingSlotsState.forEach((val, i) => {
            const char = spellingTargetWord[i];
            if (char !== ' ' && char !== '-') {
                spellingSlotsState[i] = null;
                const slotEl = document.getElementById(`slot-${i}`);
                slotEl.innerHTML = '&nbsp;';
                slotEl.classList.remove('filled');
                delete slotEl.dataset.bubbleId;
            }
        });
        
        // Restore all bubbles
        document.querySelectorAll('.bubble-btn').forEach(b => {
            b.classList.remove('used');
            b.style.pointerEvents = 'auto';
        });
    });

    // Speak helper for test question
    document.getElementById('test-speak-btn').addEventListener('click', () => {
        const item = testingQueue[testingIndex];
        const textKey = item.word || item.phrase;
        if (textKey) speakText(textKey);
    });

    // Handle feedback & increment index
    function handleAnswerFeedback(isCorrect) {
        const item = testingQueue[testingIndex];
        
        if (isCorrect) {
            AudioEngine.playCorrect();
            testingScore++;
        } else {
            AudioEngine.playIncorrect();
            testingIncorrectList.push(item);
            
            // Add to Global Error Book
            const alreadyExists = errorBook.some(e => (e.word || e.phrase) === (item.word || item.phrase));
            if (!alreadyExists) {
                errorBook.push(item);
                saveUserData();
                updateDashboardStats();
            }
        }
        
        // Visual indicator flashing on background viewport
        const viewport = document.getElementById('app-viewport');
        const flashClass = isCorrect ? 'correct-flash' : 'incorrect-flash';
        
        // Let's create the flashing overlay temporarily
        const flashOverlay = document.createElement('div');
        flashOverlay.style.position = 'absolute';
        flashOverlay.style.top = '0';
        flashOverlay.style.left = '0';
        flashOverlay.style.width = '100%';
        flashOverlay.style.height = '100%';
        flashOverlay.style.backgroundColor = isCorrect ? 'rgba(16, 185, 129, 0.12)' : 'rgba(239, 68, 68, 0.12)';
        flashOverlay.style.pointerEvents = 'none';
        flashOverlay.style.zIndex = '10';
        flashOverlay.style.transition = 'opacity 0.4s ease';
        viewport.appendChild(flashOverlay);
        
        setTimeout(() => {
            flashOverlay.style.opacity = '0';
            setTimeout(() => flashOverlay.remove(), 400);
        }, 300);
        
        // Move forward after delay
        const delay = isCorrect ? 800 : 1500;
        setTimeout(() => {
            testingIndex++;
            setupNextTestQuestion();
        }, delay);
    }

    // ----------------------------------------------------
    // Testing Results Screen
    // ----------------------------------------------------
    function showAssessmentResult() {
        const total = testingQueue.length;
        const accuracy = Math.round((testingScore / total) * 100);
        
        // Draw SVG ring
        const circle = document.getElementById('result-ring-fill');
        const radius = circle.r.baseVal.value;
        const circumference = 2 * Math.PI * radius;
        const offset = circumference - (accuracy / 100) * circumference;
        circle.style.strokeDashoffset = offset;
        
        // Score labels
        document.getElementById('result-score-pct').innerText = `${accuracy}%`;
        document.getElementById('result-score-ratio').innerText = `${testingScore} / ${total}`;
        
        // Text verdicts
        const verdictEl = document.getElementById('result-verdict');
        const summaryEl = document.getElementById('result-summary-text');
        
        if (accuracy === 100) {
            verdictEl.innerText = "完美通过！🥇";
            verdictEl.style.color = 'var(--success)';
            summaryEl.innerText = isIncorrectOnlySession ? 
                "你已成功消灭了所有错词！" : 
                "恭喜你，答对了全部的题目！";
                
            // Update group status to completed
            const progressObj = currentMode === 'words' ? userProgress.words : userProgress.phrases;
            progressObj[currentGroupId] = 'completed';
            saveUserData();
            updateDashboardStats();
        } else {
            verdictEl.innerText = "还需加油！💪";
            verdictEl.style.color = 'var(--warning)';
            summaryEl.innerText = `本次测试有 ${testingIncorrectList.length} 个错词，请反复巩固直至全对。`;
        }
        
        // Render wrong words list
        const listContainer = document.getElementById('wrong-words-list');
        const wrongPanel = document.getElementById('wrong-words-panel');
        listContainer.innerHTML = '';
        
        if (testingIncorrectList.length > 0) {
            wrongPanel.style.display = 'flex';
            document.getElementById('wrong-words-count').innerText = testingIncorrectList.length;
            
            testingIncorrectList.forEach(item => {
                const row = document.createElement('div');
                row.className = 'wrong-item-row';
                row.innerHTML = `
                    <span class="wrong-item-eng">${item.word || item.phrase}</span>
                    <span class="wrong-item-chn">${item.translation}</span>
                `;
                listContainer.appendChild(row);
            });
            
            // Show retry button
            document.getElementById('result-retry-btn').style.display = 'block';
        } else {
            wrongPanel.style.display = 'none';
            document.getElementById('result-retry-btn').style.display = 'none';
        }
        
        switchScreen('result-screen');
    }

    // Result action clicks
    document.getElementById('result-retry-btn').addEventListener('click', () => {
        startIncorrectOnlyAssessment();
    });
    
    document.getElementById('result-home-btn').addEventListener('click', () => {
        renderGroupList();
        updateDashboardStats();
        switchScreen('home-screen');
    });

    // ----------------------------------------------------
    // Error Book (生词本)
    // ----------------------------------------------------
    function renderErrorBook() {
        const container = document.getElementById('errorbook-list');
        container.innerHTML = '';
        
        const intro = document.getElementById('errorbook-intro');
        const practiceBtn = document.getElementById('errorbook-practice-btn');
        
        if (errorBook.length === 0) {
            intro.innerText = "你的生词本是空的哦，太棒了！✨";
            practiceBtn.style.display = 'none';
            return;
        }
        
        intro.innerText = `你的生词本里收集了 ${errorBook.length} 个在测试中答错的项。`;
        practiceBtn.style.display = 'block';
        
        errorBook.forEach((item, idx) => {
            const card = document.createElement('div');
            card.className = 'vocab-card';
            
            card.innerHTML = `
                <div class="vocab-content">
                    <span class="vocab-word">${item.word || item.phrase}</span>
                    <span class="vocab-trans">${item.phonetic ? item.phonetic + ' ' : ''}${item.translation}</span>
                </div>
                <button class="delete-vocab-btn" aria-label="删除" data-idx="${idx}">✕</button>
            `;
            
            // Click to speak word
            card.addEventListener('click', (e) => {
                if (!e.target.classList.contains('delete-vocab-btn')) {
                    speakText(item.word || item.phrase);
                }
            });
            
            // Delete button click
            card.querySelector('.delete-vocab-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                const removeIdx = parseInt(e.target.dataset.idx);
                errorBook.splice(removeIdx, 1);
                saveUserData();
                renderErrorBook();
                updateDashboardStats();
            });
            
            container.appendChild(card);
        });
    }

    document.getElementById('go-errorbook-btn').addEventListener('click', () => {
        renderErrorBook();
        switchScreen('errorbook-screen');
    });
    
    document.getElementById('errorbook-back-btn').addEventListener('click', () => {
        renderGroupList();
        switchScreen('home-screen');
    });

    // Review/Practice Error Book items
    document.getElementById('errorbook-practice-btn').addEventListener('click', () => {
        // Build assessment session with all errorbook items
        currentGroupId = -1; // Special indicator
        currentGroupItems = [...errorBook];
        
        startGroupAssessment();
    });

    document.getElementById('clear-errorbook-btn').addEventListener('click', () => {
        if (errorBook.length === 0) return;
        if (confirm("确定要清空生词本中的所有单词吗？")) {
            errorBook = [];
            saveUserData();
            renderErrorBook();
            updateDashboardStats();
        }
    });

    // ----------------------------------------------------
    // Settings Actions & Overlays
    // ----------------------------------------------------
    document.getElementById('settings-btn').addEventListener('click', () => {
        settingsModal.classList.add('active');
    });

    document.getElementById('settings-close-btn').addEventListener('click', () => {
        // Save speed
        const speed = parseFloat(document.getElementById('setting-speech-rate').value);
        settings.speechRate = speed;
        
        // Save test mode
        const mode = document.querySelector('input[name="test-mode"]:checked').value;
        settings.testMode = mode;
        
        saveUserData();
        settingsModal.classList.remove('active');
    });
    
    document.getElementById('setting-speech-rate').addEventListener('input', (e) => {
        document.getElementById('speech-rate-val').innerText = e.target.value;
    });

    document.getElementById('reset-progress-btn').addEventListener('click', () => {
        if (confirm("这会清空你所有的背诵记录、生词本以及配置。确定继续吗？")) {
            localStorage.removeItem('cet6_progress');
            localStorage.removeItem('cet6_errorbook');
            localStorage.removeItem('cet6_settings');
            
            userProgress = { words: {}, phrases: {} };
            errorBook = [];
            settings = { speechRate: 0.9, testMode: 'spelling' };
            
            // Reset sliders
            document.getElementById('setting-speech-rate').value = 0.9;
            document.getElementById('speech-rate-val').innerText = '0.9';
            document.querySelector('input[name="test-mode"][value="spelling"]').checked = true;
            
            saveUserData();
            updateDashboardStats();
            renderGroupList();
            
            settingsModal.classList.remove('active');
            alert("所有数据已重置。");
        }
    });

    // Tabs clicks
    document.getElementById('tab-words').addEventListener('click', () => {
        if (currentMode === 'words') return;
        currentMode = 'words';
        document.getElementById('tab-words').classList.add('active');
        document.getElementById('tab-phrases').classList.remove('active');
        renderGroupList();
    });

    document.getElementById('tab-phrases').addEventListener('click', () => {
        if (currentMode === 'phrases') return;
        currentMode = 'phrases';
        document.getElementById('tab-phrases').classList.add('active');
        document.getElementById('tab-words').classList.remove('active');
        renderGroupList();
    });

    // Exit & back events
    document.getElementById('learn-back-btn').addEventListener('click', () => {
        renderGroupList();
        updateDashboardStats();
        switchScreen('home-screen');
    });

    document.getElementById('test-exit-btn').addEventListener('click', () => {
        if (confirm("测试正在进行中，退出将丢失本次得分进度。确定退出吗？")) {
            renderGroupList();
            updateDashboardStats();
            switchScreen('home-screen');
        }
    });

    // Device mockup Home Button click logic
    const homeBtn = document.getElementById('device-home-button');
    if (homeBtn) {
        homeBtn.addEventListener('click', () => {
            renderGroupList();
            updateDashboardStats();
            switchScreen('home-screen');
        } );
    }

    // ----------------------------------------------------
    // General Helper Functions
    // ----------------------------------------------------
    function shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }

    // ----------------------------------------------------
    // Application Initialization
    // ----------------------------------------------------
    function initializeApp() {
        loadUserData();
        updateDashboardStats();
        renderGroupList();
        
        // Check if database loaded correctly
        if (typeof WORDS_DATABASE === 'undefined') {
            console.error("WORDS_DATABASE is not loaded! Check words_data.js.");
            alert("词汇数据库加载失败！请检查 words_data.js。");
        }
    }

    initializeApp();
});
