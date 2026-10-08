# Project Overview: ERP Attendance Automator

## The Problem
Right now, professors at your college have to manually mark attendance on an old ERP system. They have to scroll through a list of 60 to 80 students and click a button multiple times to toggle a student's status between **Present**, **Absent**, and **Exemption**. This process is incredibly slow, tedious, and prone to human error. 

## The Solution
We built a **Google Chrome Extension**. You can think of a Chrome Extension as a mini-program that lives inside the web browser. When the professor logs into the college ERP, our mini-program wakes up, reads a spreadsheet of absent students, and does all the clicking for the professor in about 2 seconds.

---

## The Architecture (How it works under the hood)

Even though it looks like magic on the screen, the extension is built using three main technical components:

### 1. The ID Card (`manifest.json`)
Every Chrome Extension requires a "Manifest" file. This is basically the ID card that introduces the extension to the browser. 
* It tells Chrome the name of our app.
* It asks Chrome for permission to run JavaScript code on web pages.
* Most importantly, it tells Chrome to inject our code into **all frames** of a website. This is crucial because your college ERP hides the attendance list inside an older web technology called an `iframe` (a webpage inside a webpage). 

### 2. The Brain (`content.js`)
This is the core logic of the project, written in JavaScript. It performs three main tasks:

* **The Watchdog (Detection):** As soon as the browser opens, this script runs silently in the background. Every 2 seconds, it scans the underlying HTML code of the screen looking for a specific tag (specifically, an ID ending in `_tdRollNo`). The moment it finds this tag, it knows the professor has successfully opened the Attendance page.
* **The Interface (UI Injection):** Once it knows the page is open, it injects custom HTML and CSS directly onto the screen. This creates the clean, floating box in the bottom right corner that asks the professor to upload their CSV file.
* **The Automation:** When the CSV is uploaded, the script maps out the entire classroom by reading the PRNs directly off the screen. It compares the screen to the CSV list. If a student is on the absent list, it targets their specific button on the screen and clicks it. 

### 3. The Data Reader (`papaparse.min.js`)
This is a lightweight open-source library we included in the extension. When the professor uploads the `.csv` file, this library instantly reads the spreadsheet. It is programmed to intelligently hunt for a column named **"PRN"** or **"Roll"** and pull out the numbers, completely ignoring any other messy data (like names or timestamps) that might be in the file.

---

## Technical Highlights & Safety Features

* **No Hardcoding:** The system dynamically reads the screen. Whether a class has 15 students or 120 students, the code adapts perfectly.
* **Feedback Loop:** The extension doesn't just blindly double-click buttons. When it clicks a student to mark them Absent, it actually reads a hidden piece of code on the college website (`_hdnONE`) to verify that the college server actually registered the click. If the server lags, our script clicks again until it is certain the status is correct.
* **Database Safety:** We intentionally removed the ability for the bot to click the final "Update" (Save) button. The bot does all the visual sorting and clicking, but it stops and alerts the professor when it finishes. The professor must manually click "Update". This guarantees that a software bug can never accidentally wipe out or corrupt the college's live database.
