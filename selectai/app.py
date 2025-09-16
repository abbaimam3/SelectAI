import streamlit as st
import pandas as pd

# --- App Config ---
st.set_page_config(page_title="SelectAI Prototype", layout="wide")

st.title("SelectAI — AI-Driven Applicant Selection Tool")
st.write("Upload applicant data (CSV) → Rank candidates → Export shortlist.")

# --- File Upload ---
uploaded_file = st.file_uploader("Upload CSV of applicants", type=["csv"])

if uploaded_file:
    df = pd.read_csv(uploaded_file)
    st.subheader("Uploaded Data")
    st.dataframe(df)

    # Example scoring: weighted sum of education, experience, and skills
    if {"Education", "Experience", "Skills"}.issubset(df.columns):
        st.subheader("Candidate Ranking")

        # Normalize scores
        df["Education_Score"] = df["Education"].rank(pct=True) * 40
        df["Experience_Score"] = df["Experience"].rank(pct=True) * 40
        df["Skills_Score"] = df["Skills"].rank(pct=True) * 20

        df["Final_Score"] = df["Education_Score"] + df["Experience_Score"] + df["Skills_Score"]
        ranked = df.sort_values("Final_Score", ascending=False)

        st.write("### Ranked Applicants")
        st.dataframe(ranked[["Name", "Education", "Experience", "Skills", "Final_Score"]])

        # Export shortlist
        st.download_button(
            "Download Ranked List (CSV)",
            ranked.to_csv(index=False).encode("utf-8"),
            "shortlist.csv",
            "text/csv"
        )
    else:
        st.error("CSV must contain columns: Name, Education, Experience, Skills")
else:
    st.info("Upload a CSV file with applicant data to begin.")